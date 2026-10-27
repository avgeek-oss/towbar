import assert from "node:assert/strict";
import { test } from "node:test";

import {
  freshPublicLookup,
  resolveFromAuthoritativeNameservers,
} from "./public-dns.js";

import type { LookupAddress } from "node:dns";

const notFound = () =>
  Object.assign(new Error("getaddrinfo ENOTFOUND preview.example.com"), {
    code: "ENOTFOUND",
  });

function lookupOnce(lookup: ReturnType<typeof freshPublicLookup>, all = false) {
  return new Promise<{
    error: NodeJS.ErrnoException | null;
    result: string | LookupAddress[];
    family?: number;
  }>((resolve) =>
    lookup("preview.example.com", { all }, (error, result, family) =>
      resolve({ error, result, family }),
    ),
  );
}

void test("uses the system resolver when it answers", async () => {
  let authoritativeCalls = 0;
  const lookup = freshPublicLookup({
    lookup: (_hostname, callback) =>
      callback(null, [{ address: "192.0.2.10", family: 4 }]),
    resolveAuthoritative: () => {
      authoritativeCalls += 1;
      return Promise.resolve([]);
    },
  });
  const answer = await lookupOnce(lookup);
  assert.equal(answer.error, null);
  assert.equal(answer.result, "192.0.2.10");
  assert.equal(answer.family, 4);
  assert.equal(authoritativeCalls, 0);
});

void test("bypasses a cached negative answer for a newly created record", async () => {
  const lookup = freshPublicLookup({
    lookup: (_hostname, callback) => callback(notFound(), []),
    resolveAuthoritative: () =>
      Promise.resolve([
        { address: "198.51.100.7", family: 4 },
        { address: "2001:db8::7", family: 6 },
      ]),
  });
  const single = await lookupOnce(lookup);
  assert.equal(single.error, null);
  assert.equal(single.result, "198.51.100.7");
  const all = await lookupOnce(lookup, true);
  assert.deepEqual(all.result, [
    { address: "198.51.100.7", family: 4 },
    { address: "2001:db8::7", family: 6 },
  ]);
});

void test("keeps the system error when authoritative nameservers have no record", async () => {
  const systemError = notFound();
  for (const resolveAuthoritative of [
    () => Promise.resolve([]),
    () => Promise.reject(new Error("SERVFAIL")),
  ]) {
    const answer = await lookupOnce(
      freshPublicLookup({
        lookup: (_hostname, callback) => callback(systemError, []),
        resolveAuthoritative,
      }),
    );
    assert.equal(answer.error, systemError);
  }
});

void test("does not retry other resolver failures authoritatively", async () => {
  const timeout = Object.assign(new Error("getaddrinfo EAI_AGAIN"), {
    code: "EAI_AGAIN",
  });
  let authoritativeCalls = 0;
  const answer = await lookupOnce(
    freshPublicLookup({
      lookup: (_hostname, callback) => callback(timeout, []),
      resolveAuthoritative: () => {
        authoritativeCalls += 1;
        return Promise.resolve([{ address: "192.0.2.10", family: 4 }]);
      },
    }),
  );
  assert.equal(answer.error, timeout);
  assert.equal(authoritativeCalls, 0);
});

void test("asks the closest enclosing zone's nameservers", async () => {
  const zones: string[] = [];
  const queried: Array<{ servers: string[]; hostname: string }> = [];
  const addresses = await resolveFromAuthoritativeNameservers(
    "app-pr-15-abc.example.com",
    {
      resolveNs: (zone) => {
        zones.push(zone);
        return zone === "example.com"
          ? Promise.resolve(["ns1.dns.example.net", "ns2.dns.example.net"])
          : Promise.reject(notFound());
      },
      lookupAll: (nameserver) =>
        Promise.resolve([
          {
            address: nameserver.startsWith("ns1") ? "192.0.2.53" : "192.0.2.54",
            family: 4,
          },
        ]),
      resolveAt: (servers, hostname) => {
        queried.push({ servers, hostname });
        return Promise.resolve([{ address: "198.51.100.7", family: 4 }]);
      },
    },
  );
  assert.deepEqual(zones, ["app-pr-15-abc.example.com", "example.com"]);
  assert.deepEqual(queried, [
    {
      servers: ["192.0.2.53", "192.0.2.54"],
      hostname: "app-pr-15-abc.example.com",
    },
  ]);
  assert.deepEqual(addresses, [{ address: "198.51.100.7", family: 4 }]);
});

void test("stops above the top-level domain", async () => {
  const zones: string[] = [];
  const addresses = await resolveFromAuthoritativeNameservers(
    "missing.example.com",
    {
      resolveNs: (zone) => {
        zones.push(zone);
        return Promise.resolve([]);
      },
      lookupAll: () => Promise.resolve([]),
      resolveAt: () => Promise.resolve([]),
    },
  );
  assert.deepEqual(zones, ["missing.example.com", "example.com"]);
  assert.deepEqual(addresses, []);
});
