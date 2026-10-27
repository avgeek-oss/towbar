import { promises as dns, lookup as lookupCallback } from "node:dns";

import type { LookupAddress } from "node:dns";
import type { LookupFunction } from "node:net";

type SystemLookup = (
  hostname: string,
  callback: (
    error: NodeJS.ErrnoException | null,
    addresses: LookupAddress[],
  ) => void,
) => void;

type AuthoritativeDns = {
  resolveNs: (zone: string) => Promise<string[]>;
  lookupAll: (hostname: string) => Promise<LookupAddress[]>;
  resolveAt: (servers: string[], hostname: string) => Promise<LookupAddress[]>;
};

const systemLookup: SystemLookup = (hostname, callback) =>
  lookupCallback(hostname, { all: true, verbatim: true }, callback);

const nodeAuthoritativeDns: AuthoritativeDns = {
  resolveNs: (zone) => dns.resolveNs(zone),
  lookupAll: (hostname) => dns.lookup(hostname, { all: true }),
  async resolveAt(servers, hostname) {
    const resolver = new dns.Resolver({ timeout: 3_000, tries: 2 });
    resolver.setServers(servers);
    const [ipv4, ipv6] = await Promise.allSettled([
      resolver.resolve4(hostname),
      resolver.resolve6(hostname),
    ]);
    return [
      ...(ipv4.status === "fulfilled" ? ipv4.value : []).map((address) => ({
        address,
        family: 4,
      })),
      ...(ipv6.status === "fulfilled" ? ipv6.value : []).map((address) => ({
        address,
        family: 6,
      })),
    ];
  },
};

/**
 * Resolves through the system resolver, then asks the domain's authoritative
 * nameservers when it reports ENOTFOUND. A record created moments earlier, such
 * as a Preview hostname, can otherwise stay hidden behind a cached negative
 * answer for the zone's SOA minimum TTL.
 */
export function freshPublicLookup(
  dependencies: {
    lookup?: SystemLookup;
    resolveAuthoritative?: (hostname: string) => Promise<LookupAddress[]>;
  } = {},
): LookupFunction {
  const lookup = dependencies.lookup ?? systemLookup;
  const resolveAuthoritative =
    dependencies.resolveAuthoritative ?? resolveFromAuthoritativeNameservers;
  return (hostname, options, callback) => {
    const complete = (addresses: LookupAddress[]) => {
      if (options.all) return callback(null, addresses);
      const selected = addresses[0]!;
      return callback(null, selected.address, selected.family);
    };
    lookup(hostname, (error, addresses) => {
      if (!error && addresses.length) return complete(addresses);
      if (error && error.code !== "ENOTFOUND") return callback(error, "", 0);
      const notFound =
        error ??
        Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
          code: "ENOTFOUND",
        });
      resolveAuthoritative(hostname).then(
        (fresh) => (fresh.length ? complete(fresh) : callback(notFound, "", 0)),
        () => callback(notFound, "", 0),
      );
    });
  };
}

export async function resolveFromAuthoritativeNameservers(
  hostname: string,
  resolver: AuthoritativeDns = nodeAuthoritativeDns,
) {
  const labels = hostname.replace(/\.$/u, "").split(".");
  // Stop above the top-level domain, whose servers only return referrals.
  for (let index = 0; index < labels.length - 1; index += 1) {
    const zone = labels.slice(index).join(".");
    const nameservers = await resolver.resolveNs(zone).catch(() => []);
    if (!nameservers.length) continue;
    const servers = (
      await Promise.all(
        nameservers.map((nameserver) =>
          resolver.lookupAll(nameserver).catch(() => []),
        ),
      )
    )
      .flat()
      .map((entry) => entry.address);
    return servers.length ? await resolver.resolveAt(servers, hostname) : [];
  }
  return [];
}
