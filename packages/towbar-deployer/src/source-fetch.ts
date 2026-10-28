import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, opendir, realpath } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

import { runCommand } from "./process.js";

import type { DeploymentExecutionContext } from "./types.js";

export const MAX_SOURCE_ARCHIVE_BYTES = 512 * 1024 * 1024;
export const MAX_SOURCE_EXPANDED_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_SOURCE_ARCHIVE_ENTRIES = 100_000;

export function createSourceArchiveLimit(maxBytes = MAX_SOURCE_ARCHIVE_BYTES) {
  let receivedBytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      receivedBytes += chunk.byteLength;
      if (receivedBytes > maxBytes) {
        callback(
          new Error(
            `Repository source archive exceeds the ${maxBytes}-byte safety limit`,
          ),
        );
        return;
      }
      callback(null, chunk);
    },
  });
}

export async function inspectSourceArchive(
  archivePath: string,
  options: {
    maxBytes?: number;
    maxEntries?: number;
    signal?: AbortSignal;
  } = {},
) {
  const inspector = createExpandedArchiveLimit({
    maxBytes: options.maxBytes ?? MAX_SOURCE_EXPANDED_BYTES,
    maxEntries: options.maxEntries ?? MAX_SOURCE_ARCHIVE_ENTRIES,
  });
  await pipeline(
    createReadStream(archivePath),
    createGunzip(),
    inspector,
    options.signal ? { signal: options.signal } : {},
  );
}

export function createExpandedArchiveLimit(input: {
  maxBytes: number;
  maxEntries: number;
}) {
  let expandedBytes = 0;
  let entries = 0;
  let buffered = Buffer.alloc(0);
  let remainingPayloadBytes = 0;

  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        expandedBytes += chunk.byteLength;
        if (expandedBytes > input.maxBytes) {
          throw new Error(
            `Expanded source archive exceeds the ${input.maxBytes}-byte safety limit`,
          );
        }
        buffered = buffered.length
          ? Buffer.concat([buffered, chunk])
          : Buffer.from(chunk);
        while (buffered.length > 0) {
          if (remainingPayloadBytes > 0) {
            const consumed = Math.min(remainingPayloadBytes, buffered.length);
            buffered = buffered.subarray(consumed);
            remainingPayloadBytes -= consumed;
            continue;
          }
          if (buffered.length < 512) break;
          const header = buffered.subarray(0, 512);
          buffered = buffered.subarray(512);
          if (header.every((value) => value === 0)) continue;
          entries += 1;
          if (entries > input.maxEntries) {
            throw new Error(
              `Source archive exceeds the ${input.maxEntries}-entry safety limit`,
            );
          }
          const size = parseTarSize(header.subarray(124, 136));
          remainingPayloadBytes = Math.ceil(size / 512) * 512;
        }
        callback();
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
    flush(callback) {
      if (remainingPayloadBytes > 0) {
        callback(new Error("Source archive ended inside a file payload"));
        return;
      }
      if (buffered.length > 0 && !buffered.every((value) => value === 0)) {
        callback(new Error("Source archive ended inside a tar header"));
        return;
      }
      callback();
    },
  });
}

export async function fetchDeploymentSource(
  context: DeploymentExecutionContext,
  localDirectory: string,
  signal?: AbortSignal,
) {
  if (!context.sourceCredential) {
    throw new Error("Repository credentials are required to fetch source");
  }
  const archivePath = path.join(localDirectory, "source.tar.gz");
  const checkoutPath = path.join(localDirectory, "checkout");
  await mkdir(checkoutPath, { mode: 0o700 });
  const credential = context.sourceCredential;
  const owner = encodeURIComponent(context.repositoryOwner);
  const repository = encodeURIComponent(context.repositoryName);
  const url = `${credential.apiUrl.replace(/\/$/u, "")}/repos/${owner}/${repository}/tarball/${context.commitSha}`;
  const response = await globalThis.fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${credential.token}`,
      "user-agent": "towbar.dev",
      "x-github-api-version": "2022-11-28",
    },
    redirect: "follow",
    signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(
      `GitHub archive request failed with status ${response.status}`,
    );
  }
  const declaredSize = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredSize) &&
    declaredSize > MAX_SOURCE_ARCHIVE_BYTES
  ) {
    throw new Error(
      `Repository source archive exceeds the ${MAX_SOURCE_ARCHIVE_BYTES}-byte safety limit`,
    );
  }
  await pipeline(
    Readable.fromWeb(response.body as never),
    createSourceArchiveLimit(),
    createWriteStream(archivePath, { mode: 0o600 }),
  );
  await inspectSourceArchive(archivePath, { signal });
  await runCommand(
    "tar",
    [
      "-xzf",
      archivePath,
      "--strip-components=1",
      "--no-same-owner",
      "--no-same-permissions",
      "-C",
      checkoutPath,
    ],
    { signal, timeoutMs: 120_000 },
  );
  await validateExtractedCheckout(checkoutPath);
  return checkoutPath;
}

async function validateExtractedCheckout(checkoutPath: string) {
  const root = await realpath(checkoutPath);
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop()!;
    const entries = await opendir(directory);
    for await (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      const metadata = await lstat(candidate);
      if (metadata.isDirectory()) {
        pending.push(candidate);
        continue;
      }
      if (metadata.isFile()) continue;
      if (metadata.isSymbolicLink()) {
        let resolved: string;
        try {
          resolved = await realpath(candidate);
        } catch {
          throw new Error("Repository source contains a broken symbolic link");
        }
        if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`))
          throw new Error(
            "Repository source contains a symbolic link outside the checkout",
          );
        continue;
      }
      throw new Error("Repository source contains an unsupported special file");
    }
  }
}

function parseTarSize(field: Buffer) {
  if ((field[0] ?? 0) & 0x80) {
    const bytes = Buffer.from(field);
    bytes[0] = (bytes[0] ?? 0) & 0x7f;
    let value = 0n;
    for (const byte of bytes) value = value * 256n + BigInt(byte);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("Source archive contains an oversized tar entry");
    }
    return Number(value);
  }
  const value = field.toString("ascii").replace(/\0.*$/u, "").trim();
  if (!value) return 0;
  if (!/^[0-7]+$/u.test(value)) {
    throw new Error("Source archive contains an invalid tar entry size");
  }
  return Number.parseInt(value, 8);
}
