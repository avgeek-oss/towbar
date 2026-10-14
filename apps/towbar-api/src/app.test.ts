import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

process.env.DATABASE_TOWBAR_URL =
  "postgres://towbar:test@127.0.0.1:5432/towbar";
process.env.DATABASE_TOWBAR_MIGRATOR_URL = process.env.DATABASE_TOWBAR_URL;
process.env.TOWBAR_CREDENTIALS_KEY =
  "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";
process.env.TOWBAR_INTERNAL_HMAC_SECRET =
  "test-hmac-secret-that-is-long-enough";
process.env.TOWBAR_APP_BASE_URL = "https://app.towbar.test";
process.env.TOWBAR_API_BASE_URL = "https://api.towbar.test";

let app: Awaited<ReturnType<typeof loadApp>>;
let internalApp: Awaited<ReturnType<typeof loadInternalApp>>;

async function loadApp() {
  const { createApp } = await import("./app.js");
  return createApp();
}

async function loadInternalApp() {
  const { createInternalApp } = await import("./app.js");
  return createInternalApp();
}

void before(async () => {
  app = await loadApp();
  internalApp = await loadInternalApp();
});

void describe("Towbar API boundaries", () => {
  void it("serves its favicon publicly as PNG through the canonical path", async () => {
    const response = await app.request("/favicon.ico");
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/brand/towbar-favicon.png");
    const image = await app.request(response.headers.get("location")!);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.match(image.headers.get("cache-control") ?? "", /public/u);
    assert.equal(
      Buffer.from(await image.arrayBuffer())
        .subarray(0, 8)
        .toString("hex"),
      "89504e470d0a1a0a",
    );
  });
  void it("publishes API-origin OAuth discovery and allows UI-origin consent preflights", async () => {
    const response = await app.request(
      "/.well-known/oauth-authorization-server",
    );
    assert.equal(response.status, 200);
    const metadata = (await response.json()) as Record<string, unknown>;
    assert.equal(metadata.issuer, "https://api.towbar.test");
    assert.equal(
      metadata.authorization_endpoint,
      "https://api.towbar.test/v1/oauth/authorize",
    );
    const path = "/v1/oauth/consent/00000000-0000-4000-8000-000000000000";
    const trusted = await app.request(path, {
      method: "OPTIONS",
      headers: {
        origin: "https://app.towbar.test",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    assert.equal(trusted.status, 204);
    assert.equal(
      trusted.headers.get("access-control-allow-origin"),
      "https://app.towbar.test",
    );
    assert.equal(
      trusted.headers.get("access-control-allow-credentials"),
      "true",
    );
    const untrusted = await app.request(path, {
      method: "OPTIONS",
      headers: {
        origin: "https://attacker.test",
        "access-control-request-method": "POST",
      },
    });
    assert.equal(untrusted.headers.get("access-control-allow-origin"), null);
  });
  void it("does not expose a public signup route", async () => {
    const response = await app.request("/v1/public/signup", { method: "POST" });
    assert.equal(response.status, 404);
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, "NOT_FOUND");
  });

  void it("allows credentialed CORS only from configured first-party origins", async () => {
    const trusted = await app.request("/v1/core/session", {
      headers: {
        "access-control-request-method": "GET",
        origin: "https://app.towbar.test",
      },
      method: "OPTIONS",
    });
    assert.equal(
      trusted.headers.get("access-control-allow-origin"),
      "https://app.towbar.test",
    );
    assert.equal(
      trusted.headers.get("access-control-allow-credentials"),
      "true",
    );

    const untrusted = await app.request("/v1/core/session", {
      headers: {
        "access-control-request-method": "GET",
        origin: "https://attacker.test",
      },
      method: "OPTIONS",
    });
    assert.equal(untrusted.headers.get("access-control-allow-origin"), null);
  });

  void it("does not mount worker routes on the public listener", async () => {
    const response = await app.request("/v1/internal/health");
    assert.equal(response.status, 404);
  });

  void it("rejects unsigned worker requests on the internal listener", async () => {
    const response = await internalApp.request("/v1/internal/health");
    assert.equal(response.status, 401);
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, "UNAUTHORIZED");
  });

  void it("rejects oversized GitHub webhooks before signature work", async () => {
    const response = await app.request("/v1/public/webhooks/github", {
      body: "x".repeat(2 * 1_024 * 1_024 + 1),
      method: "POST",
    });
    assert.equal(response.status, 413);
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, "PAYLOAD_TOO_LARGE");
  });

  void it("rejects public authentication mutations without the app origin", async () => {
    const response = await app.request("/v1/public/auth/login-email", {
      method: "POST",
    });
    assert.equal(response.status, 403);
  });

  void it("allows public authentication mutations only from the app origin", async () => {
    const trusted = await app.request("/v1/public/auth/login-email", {
      headers: { origin: "https://app.towbar.test" },
      method: "POST",
    });
    assert.equal(trusted.status, 400);

    const formerSso = await app.request("/v1/public/auth/login-email", {
      headers: { origin: "https://sso.towbar.test" },
      method: "POST",
    });
    assert.equal(formerSso.status, 403);
  });

  void it("does not expose authorization-code or password-recovery routes", async () => {
    for (const path of [
      "/v1/public/auth/exchange-code",
      "/v1/public/auth/forgot-password",
      "/v1/public/auth/reset-password",
    ]) {
      const response = await app.request(path, {
        headers: { origin: "https://app.towbar.test" },
        method: "POST",
      });
      assert.equal(response.status, 404, path);
    }
  });

  void it("does not expose enterprise identity protocols", async () => {
    for (const [method, path] of [
      ["POST", "/v1/public/auth/identity/sign-in/sso"],
      ["GET", "/v1/public/auth/identity/sso/saml2/sp/metadata"],
      ["GET", "/v1/public/auth/identity/scim/v2/Users"],
    ] as const) {
      const response = await app.request(path, {
        headers: { origin: "https://app.towbar.test" },
        method,
      });
      assert.equal(response.status, 404, `${method} ${path}`);
    }
  });

  void it("does not reflect invalid request identifiers", async () => {
    const response = await app.request("/v1/public/signup", {
      headers: { "x-request-id": "invalid request id with spaces" },
      method: "POST",
    });
    assert.notEqual(
      response.headers.get("x-request-id"),
      "invalid request id with spaces",
    );
    assert.match(
      response.headers.get("x-request-id") ?? "",
      /^[a-f0-9-]{36}$/u,
    );
  });
});
