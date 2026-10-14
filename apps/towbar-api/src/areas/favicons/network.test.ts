import assert from "node:assert/strict";
import test from "node:test";
import { iconLookup, iconUrl, isPublicIconAddress } from "./network.js";

void test("favicon connections exclude private, special and IPv4-mapped IPv6 addresses", () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.100.100.200",
    "0.0.0.0",
    "192.0.2.1",
    "198.18.0.1",
    "224.0.0.1",
    "::",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "64:ff9b::a00:1",
    "2002:7f00:1::",
    "2001:db8::1",
    "not-an-ip",
  ])
    assert.equal(isPublicIconAddress(address), false, address);
  for (const address of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"])
    assert.equal(isPublicIconAddress(address), true, address);
});

void test("URLs require a public HTTPS hostname with no credentials or alternate ports", () => {
  for (const url of [
    "file:///etc/passwd",
    "http://web.example.com/icon",
    "https://localhost/icon",
    "https://a.local/icon",
    "https://a.internal./icon",
    "https://127.0.0.1/icon",
    "https://[::1]/icon",
    "https://2130706433/icon",
    "https://web.example.com:8443/icon",
    "https://user:secret@web.example.com/icon",
    `https://web.example.com/${"a".repeat(2048)}`,
  ])
    assert.throws(() => iconUrl(url), Error, url);
  assert.equal(
    iconUrl("/icon.png#fragment", new URL("https://web.example.com/app/")).href,
    "https://web.example.com/icon.png",
  );
});

void test("DNS is revalidated at connection time and rejects mixed public/private answers", async () => {
  let addresses = [{ address: "1.1.1.1", family: 4 }];
  const lookup = iconLookup((_host, _options, done) => done(null, addresses));
  const connect = () =>
    new Promise((resolve, reject) =>
      lookup("web.example.com", { all: true }, (error, result) =>
        error ? reject(error) : resolve(result),
      ),
    );
  assert.deepEqual(await connect(), addresses);
  addresses = [...addresses, { address: "::ffff:7f00:1", family: 6 }];
  await assert.rejects(connect(), /public addresses/u);
  addresses = [];
  await assert.rejects(connect(), /public addresses/u);
});
