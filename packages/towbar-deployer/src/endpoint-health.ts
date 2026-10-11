import { CommandError, runCommand } from "./process.js";

const originHealthAttempts = 90;

export async function checkPublicEndpoint(
  domain: string,
  healthPath: string,
  signal?: AbortSignal,
) {
  let lastStatus = 0;
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const requestSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
      : AbortSignal.timeout(10_000);
    const response = await fetch(`https://${domain}${healthPath}`, {
      redirect: "manual",
      signal: requestSignal,
    }).catch((error: unknown) => {
      if (signal?.aborted) throw signal.reason;
      lastError = error;
      return null;
    });
    if (response?.ok) return;
    lastStatus = response?.status ?? 0;
    if (response) lastError = undefined;
    await abortableDelay(2_000, signal);
  }
  throw new Error(publicHealthFailureMessage(domain, lastStatus, lastError), {
    cause: lastError,
  });
}

export function publicHealthFailureMessage(
  domain: string,
  status: number,
  error: unknown,
) {
  const prefix = `Public HTTPS health check failed for '${domain}'`;
  if (status) return `${prefix}: HTTP ${status}`;
  const details: string[] = [];
  for (let depth = 0; error instanceof Error && depth < 4; depth += 1) {
    const code =
      "code" in error && typeof error.code === "string"
        ? error.code
        : undefined;
    details.push(code ? `${error.message} (${code})` : error.message);
    error = error.cause;
  }
  const detail = details
    .join(": ")
    .replace(/[\r\n]/gu, " ")
    .slice(0, 300);
  return `${prefix}: ${detail || "connection failed before an HTTP response was received"}`;
}

export async function checkOriginEndpoint(
  serverIp: string,
  domain: string,
  healthPath: string,
  signal?: AbortSignal,
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < originHealthAttempts; attempt += 1) {
    try {
      await runCommand(
        "curl",
        originHealthCurlArguments(serverIp, domain, healthPath),
        { signal, timeoutMs: 15_000 },
      );
      return;
    } catch (error) {
      lastError = error;
      await abortableDelay(2_000, signal);
    }
  }
  throw new Error(originHealthFailureMessage(lastError), { cause: lastError });
}

export function originHealthFailureMessage(error: unknown) {
  if (!(error instanceof CommandError)) {
    return "Direct origin HTTPS health check failed";
  }
  const detail = error.stderr.trim().split("\n").at(-1)?.trim();
  return detail
    ? `Direct origin HTTPS health check failed: ${detail.slice(0, 300)}`
    : "Direct origin HTTPS health check failed";
}

export function originHealthCurlArguments(
  serverIp: string,
  domain: string,
  healthPath: string,
) {
  const address = serverIp.includes(":") ? `[${serverIp}]` : serverIp;
  return [
    "--fail",
    "--silent",
    "--show-error",
    "--connect-timeout",
    "5",
    "--max-time",
    "10",
    "--resolve",
    `${domain}:443:${address}`,
    `https://${domain}${healthPath}`,
  ];
}

function abortableDelay(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abortError = () =>
      signal?.reason instanceof Error
        ? signal.reason
        : new Error("Endpoint health check was cancelled");
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timeout);
      reject(abortError());
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
