import assert from "node:assert/strict";
import test from "node:test";
import { createIconCache } from "./cache.js";

void test("failed icons expire and recover without reloading the app", async () => {
  let now = 0,
    calls = 0;
  const cache = createIconCache(
    () => Promise.resolve(++calls === 1 ? null : "data:image/png;base64,icon"),
    () => now,
  );
  assert.deepEqual(await cache("one", "web.example.com"), {
    icon: null,
    expiresAt: 30_000,
  });
  now = 29_999;
  assert.equal((await cache("one", "web.example.com")).icon, null);
  assert.equal(calls, 1);
  now = 30_000;
  assert.equal(
    (await cache("one", "web.example.com")).icon,
    "data:image/png;base64,icon",
  );
  now = 329_999;
  await cache("one", "web.example.com");
  assert.equal(calls, 2);
  now = 330_000;
  await cache("one", "web.example.com");
  assert.equal(calls, 3);
});

void test("workspaces are isolated and concurrent duplicate requests are shared", async () => {
  let calls = 0;
  const cache = createIconCache(() => {
    calls++;
    return Promise.resolve("icon");
  });
  await Promise.all([
    cache("one", "web.example.com"),
    cache("one", "web.example.com"),
  ]);
  assert.equal(calls, 1);
  await cache("two", "web.example.com");
  assert.equal(calls, 2);
  assert.equal((await cache("one", null)).icon, null);
  assert.equal(calls, 2);
});

void test("discovery concurrency and retained cache size are bounded", async () => {
  const gates: Array<(value: string) => void> = [];
  const cache = createIconCache(
    () => new Promise<string>((resolve) => gates.push(resolve)),
  );
  const active = Array.from({ length: 8 }, (_, index) =>
    cache("one", `${index}.example.com`),
  );
  assert.equal((await cache("one", "overflow.example.com")).icon, null);
  assert.equal(gates.length, 8);
  gates.forEach((resolve) => resolve("icon"));
  await Promise.all(active);
  let calls = 0;
  const bounded = createIconCache(() => {
    calls++;
    return Promise.resolve("icon");
  });
  for (let index = 0; index < 129; index++)
    await bounded("one", `${index}.example.com`);
  await bounded("one", "128.example.com");
  assert.equal(calls, 129);
  await bounded("one", "0.example.com");
  assert.equal(calls, 130);
});
