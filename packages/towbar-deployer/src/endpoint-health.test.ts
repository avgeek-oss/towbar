import { setImmediate } from "node:timers/promises";
import assert from "node:assert/strict";
import { describe, it, test } from "node:test";

import {
  checkPublicEndpoint,
  originHealthCurlArguments,
  originHealthFailureMessage,
  publicHealthFailureMessage,
} from "./endpoint-health.js";
import { CommandError } from "./process.js";

void describe("direct origin health checks", () => {
  void it("pins the hostname and SNI to an IPv4 origin", () => {
    const args = originHealthCurlArguments(
      "192.0.2.10",
      "app.example.com",
      "/health",
    );
    assert.ok(args.includes("app.example.com:443:192.0.2.10"));
    assert.equal(args.at(-1), "https://app.example.com/health");
  });

  void it("brackets an IPv6 origin for curl --resolve", () => {
    const args = originHealthCurlArguments(
      "2001:db8::10",
      "app.example.com",
      "/health",
    );
    assert.ok(args.includes("app.example.com:443:[2001:db8::10]"));
  });

  void it("surfaces the final curl failure without unbounded output", () => {
    const message = originHealthFailureMessage(
      new CommandError(
        "curl exited unsuccessfully",
        "",
        `ignored\ncurl: (60) ${"x".repeat(500)}`,
      ),
    );
    assert.match(message, /curl: \(60\)/);
    assert.ok(message.length <= 345);
  });
});

void test("public health errors include hostname and the DNS or TLS failure cause", () => {
  for (const code of ["ENOTFOUND", "ERR_TLS_CERT_ALTNAME_INVALID"]) {
    const cause = Object.assign(new Error("hostname could not be reached"), {
      code,
    });
    const message = publicHealthFailureMessage(
      "ds.oss.example.com",
      0,
      new TypeError("fetch failed", { cause }),
    );
    assert.match(message, /ds\.oss\.example\.com.*fetch failed/);
    assert(message.includes(code));
  }
  assert.equal(
    publicHealthFailureMessage(
      "app.example.com",
      503,
      new Error("old DNS error"),
    ),
    "Public HTTPS health check failed for 'app.example.com': HTTP 503",
  );
  const bounded = publicHealthFailureMessage(
    "app.example.com",
    0,
    new Error("x\n".repeat(500)),
  );
  assert(!bounded.includes("\n"));
  assert(bounded.length <= 370);
});

void test("public health retries report the final connection cause instead of status zero", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const cause = Object.assign(
    new Error("getaddrinfo ENOTFOUND app.example.com"),
    { code: "ENOTFOUND" },
  );
  const error = new TypeError("fetch failed", { cause });
  const fetchMock = t.mock.method(globalThis, "fetch", () =>
    Promise.reject(error),
  );
  const check = assert.rejects(
    checkPublicEndpoint("app.example.com", "/health"),
    (failure: unknown) => {
      assert(failure instanceof Error);
      assert.equal(failure.cause, error);
      assert.match(failure.message, /ENOTFOUND/);
      assert(!failure.message.includes("status 0"));
      return true;
    },
  );
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await setImmediate();
    t.mock.timers.tick(2_000);
  }
  await check;
  assert.equal(fetchMock.mock.callCount(), 30);
});

void test("public health succeeds after a transient connection failure", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fetchMock = t.mock.method(globalThis, "fetch", () =>
    Promise.resolve(new Response("ok")),
  );
  fetchMock.mock.mockImplementationOnce(() =>
    Promise.reject(new Error("temporary DNS failure")),
  );
  const check = checkPublicEndpoint("app.example.com", "/health");
  await setImmediate();
  t.mock.timers.tick(2_000);
  await check;
  assert.equal(fetchMock.mock.callCount(), 2);
});

void test("public health preserves cancellation rather than reporting a connectivity failure", async (t) => {
  const controller = new AbortController();
  const reason = new Error("Deployment cancelled");
  controller.abort(reason);
  t.mock.method(globalThis, "fetch", () => Promise.reject(reason));
  await assert.rejects(
    checkPublicEndpoint("app.example.com", "/health", controller.signal),
    (error) => error === reason,
  );
});
