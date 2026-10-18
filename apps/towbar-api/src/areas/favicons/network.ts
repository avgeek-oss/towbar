import { type LookupAddress, lookup } from "node:dns";
import { BlockList, type LookupFunction, isIP } from "node:net";
import { Agent, fetch } from "undici";

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(address, prefix, "ipv4");
const globalIpv6 = new BlockList();
globalIpv6.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
] as const)
  blocked.addSubnet(address, prefix, "ipv6");

export function isPublicIconAddress(address: string) {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  return (
    family === 6 &&
    globalIpv6.check(address, "ipv6") &&
    !blocked.check(address, "ipv6")
  );
}

export function iconUrl(value: string, base?: URL) {
  if (value.length > 2048) throw new Error("Icon URL is too long");
  const url = new URL(value, base);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    isIP(url.hostname.replace(/^\[|\]$/gu, "")) ||
    !url.hostname.includes(".") ||
    /(?:^|\.)(?:localhost|local|internal)\.?$/iu.test(url.hostname)
  )
    throw new Error("Icon URLs must use public HTTPS hostnames on port 443");
  url.hash = "";
  return url;
}

// Validate every DNS answer at connection time, so redirects and rebinding cannot
// turn a previously public hostname into an internal connection.
export function iconLookup(
  resolve: (
    hostname: string,
    options: { all: true; verbatim: true },
    callback: (
      error: NodeJS.ErrnoException | null,
      addresses: LookupAddress[],
    ) => void,
  ) => void = lookup,
): LookupFunction {
  return (hostname, options, callback) => {
    let finished = false;
    const timer = setTimeout(() => {
      finished = true;
      callback(new Error("Icon DNS lookup timed out"), "", 0);
    }, 1500);
    timer.unref();
    resolve(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) return callback(error, "", 0);
      if (
        !addresses.length ||
        addresses.some(({ address }) => !isPublicIconAddress(address))
      )
        return callback(
          new Error("Icon hostname did not resolve only to public addresses"),
          "",
          0,
        );
      if (options.all) return callback(null, addresses);
      const first = addresses[0]!;
      callback(null, first.address, first.family);
    });
  };
}

const agent = new Agent({
  connect: { lookup: iconLookup(), timeout: 2000 },
  headersTimeout: 3000,
  bodyTimeout: 3000,
  maxHeaderSize: 16 * 1024,
  connections: 2,
});

export async function fetchIconUrl(url: URL, signal: AbortSignal) {
  return fetch(iconUrl(url.href), {
    dispatcher: agent,
    redirect: "manual",
    signal,
    headers: {
      accept: "text/html, application/json, image/*;q=0.9",
      "user-agent": "Towbar workload icons",
    },
  });
}
