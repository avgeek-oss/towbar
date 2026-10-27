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
  isAlias: (name: string) => Promise<boolean>;
  lookupAll: (hostname: string) => Promise<LookupAddress[]>;
  resolveAt: (servers: string[], hostname: string) => Promise<LookupAddress[]>;
  resolveCnameAt: (servers: string[], hostname: string) => Promise<string[]>;
};

const maxAliasDepth = 8;

const systemLookup: SystemLookup = (hostname, callback) =>
  lookupCallback(hostname, { all: true, verbatim: true }, callback);

const nodeAuthoritativeDns: AuthoritativeDns = {
  resolveNs: (zone) => dns.resolveNs(zone),
  isAlias: (name) =>
    dns.resolveCname(name).then(
      (targets) => targets.length > 0,
      () => false,
    ),
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
  resolveCnameAt(servers, hostname) {
    const resolver = new dns.Resolver({ timeout: 3_000, tries: 2 });
    resolver.setServers(servers);
    return resolver.resolveCname(hostname);
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
  visited = new Set<string>(),
): Promise<LookupAddress[]> {
  const name = hostname.replace(/\.$/u, "").toLowerCase();
  if (visited.has(name) || visited.size >= maxAliasDepth) return [];
  visited.add(name);
  const servers = await authoritativeServers(name, resolver);
  if (!servers.length) return [];
  const addresses = await resolver.resolveAt(servers, name);
  if (addresses.length) return addresses;
  // Authoritative servers answer an alias into another zone with the CNAME
  // alone, so resolve its target from that zone's nameservers.
  const [target] = await resolver
    .resolveCnameAt(servers, name)
    .catch((): string[] => []);
  return target
    ? await resolveFromAuthoritativeNameservers(target, resolver, visited)
    : [];
}

async function authoritativeServers(
  hostname: string,
  resolver: AuthoritativeDns,
) {
  const labels = hostname.split(".");
  // Stop above the top-level domain, whose servers only return referrals.
  for (let index = 0; index < labels.length - 1; index += 1) {
    const zone = labels.slice(index).join(".");
    const nameservers = await resolver.resolveNs(zone).catch(() => []);
    // A recursive NS query follows a CNAME to its target's zone. An alias is
    // never a zone apex, so its parent zone holds the record instead.
    if (!nameservers.length || (await resolver.isAlias(zone))) continue;
    const servers = (
      await Promise.all(
        nameservers.map((nameserver) =>
          resolver.lookupAll(nameserver).catch(() => []),
        ),
      )
    )
      .flat()
      .map((entry) => entry.address);
    return servers;
  }
  return [];
}
