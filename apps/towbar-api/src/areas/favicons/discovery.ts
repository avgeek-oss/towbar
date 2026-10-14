import { type DefaultTreeAdapterMap, parse } from "parse5";
import { fetchIconUrl, iconUrl } from "./network.js";

type IconResponse = Pick<Response, "status" | "body"> & {
  headers: { get(name: string): string | null };
};
export type IconFetcher = (
  url: URL,
  signal: AbortSignal,
) => Promise<IconResponse>;
const htmlLimit = 256 * 1024;
const iconLimit = 128 * 1024;
const imageTypes = new Set([
  "image/png",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "image/svg+xml",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

function iconRelation(rel: string) {
  return rel
    .toLowerCase()
    .split(/\s+/u)
    .some((value) => value === "icon" || value === "apple-touch-icon");
}

export function declaredIcons(
  html: string,
  linkHeader: string,
  documentUrl: URL,
) {
  const links: string[] = [];
  for (const link of linkHeader.split(/,(?=\s*<)/u)) {
    const href = /^\s*<([^>]+)>/u.exec(link)?.[1];
    const rel = /;\s*rel\s*=\s*(?:"([^"]*)"|([^;\s]+))/iu.exec(link);
    if (href && rel && iconRelation(rel[1] ?? rel[2] ?? "")) links.push(href);
  }
  const nodes: DefaultTreeAdapterMap["node"][] = [parse(html)];
  const htmlLinks: string[] = [];
  let base = documentUrl;
  let hasBase = false;
  while (nodes.length) {
    const node = nodes.pop()!;
    if ("tagName" in node) {
      if (node.tagName === "body" || node.tagName === "template") continue;
      const attributes = new Map(
        node.attrs.map(({ name, value }) => [name, value]),
      );
      const href = attributes.get("href");
      if (node.tagName === "base" && href && !hasBase) {
        hasBase = true;
        try {
          base = iconUrl(href, documentUrl);
        } catch {
          /* An invalid base does not authorize another origin. */
        }
      }
      if (
        node.tagName === "link" &&
        href &&
        iconRelation(attributes.get("rel") ?? "")
      )
        htmlLinks.push(href);
    }
    if ("childNodes" in node) nodes.push(...[...node.childNodes].reverse());
  }
  const urls = [
    ...links.map((href) => [href, documentUrl] as const),
    ...htmlLinks.map((href) => [href, base] as const),
  ].flatMap(([href, origin]) => {
    try {
      return [iconUrl(href, origin).href];
    } catch {
      return [];
    }
  });
  return [...new Set(urls)].slice(0, 4);
}

async function readBounded(
  response: IconResponse,
  limit: number,
  signal: AbortSignal,
) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (Number(response.headers.get("content-length")) > limit)
      throw new Error("Icon response exceeds size limit");
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, size);
      size += value.byteLength;
      if (size > limit) throw new Error("Icon response exceeds size limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
}

export async function discoverIcon(
  domain: string,
  fetcher: IconFetcher = fetchIconUrl,
  signal = AbortSignal.timeout(5000),
): Promise<string | null> {
  const origin = iconUrl(`https://${domain}/`);
  if (origin.host !== domain.toLowerCase()) return null;
  let requests = 0;
  async function load(raw: string) {
    let url = iconUrl(raw);
    for (let redirects = 0; redirects <= 3; redirects++) {
      signal.throwIfAborted();
      if (++requests > 10) throw new Error("Icon request limit reached");
      const response = await fetcher(url, signal);
      if (![301, 302, 303, 307, 308].includes(response.status))
        return { response, url };
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) throw new Error("Icon redirect has no location");
      url = iconUrl(location, url);
    }
    throw new Error("Too many icon redirects");
  }
  let documentUrl = origin;
  let candidates: string[] = [];
  try {
    const page = await load(origin.href);
    documentUrl = page.url;
    const link = page.response.headers.get("link") ?? "";
    candidates = declaredIcons("", link, documentUrl);
    const contentType = page.response.headers
      .get("content-type")
      ?.split(";")[0]
      ?.trim()
      .toLowerCase();
    let html = "";
    if (
      contentType === "text/html" &&
      page.response.status >= 200 &&
      page.response.status < 300
    )
      html = (await readBounded(page.response, htmlLimit, signal)).toString(
        "utf8",
      );
    else await page.response.body?.cancel();
    candidates = declaredIcons(html, link, documentUrl);
  } catch {
    // A JSON API, missing homepage, or failed discovery can still expose /favicon.ico.
  }
  candidates = [
    ...new Set([
      ...candidates,
      new URL("/favicon.ico", documentUrl).href,
      new URL("/favicon.ico", origin).href,
    ]),
  ];
  for (const candidate of candidates) {
    try {
      const { response } = await load(candidate);
      const type =
        response.headers
          .get("content-type")
          ?.split(";")[0]
          ?.trim()
          .toLowerCase() ?? "";
      if (
        response.status < 200 ||
        response.status >= 300 ||
        !imageTypes.has(type)
      ) {
        await response.body?.cancel();
        continue;
      }
      const bytes = await readBounded(response, iconLimit, signal);
      if (isIconImage(bytes, type))
        return `data:${type};base64,${bytes.toString("base64")}`;
    } catch {
      if (signal.aborted) break;
    }
  }
  return null;
}

function isIconImage(bytes: Buffer, type: string) {
  if (type === "image/png")
    return bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  if (type === "image/x-icon" || type === "image/vnd.microsoft.icon")
    return bytes.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]));
  if (type === "image/jpeg")
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === "image/gif")
    return /^GIF8[79]a/u.test(bytes.toString("ascii", 0, 6));
  if (type === "image/webp")
    return (
      bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WEBP"
    );
  // SVG is returned only as an image data URL, never as a same-origin document.
  return (
    type === "image/svg+xml" &&
    /^(?:\s|<\?xml[^>]*>|<!--[^]*?-->)*<svg(?:\s|>)/u.test(
      bytes.toString("utf8"),
    )
  );
}
