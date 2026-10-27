import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import type { createApp } from "../../app.js";

export function settingsTestClient(
  app: ReturnType<typeof createApp>,
  origin: string,
) {
  function cookies(response: Response, previous = new Headers({ origin })) {
    const values = new Map(
      (previous.get("cookie") ?? "")
        .split("; ")
        .filter(Boolean)
        .map((item) => [item.split("=")[0]!, item]),
    );
    for (const header of response.headers.getSetCookie()) {
      const value = header.split(";")[0]!;
      values.set(value.split("=")[0]!, value);
    }
    return new Headers({ origin, cookie: [...values.values()].join("; ") });
  }
  const request = (
    path: string,
    headers: Headers,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
  ) =>
    app.request(path, {
      method,
      headers: (() => {
        const value = new Headers(headers);
        value.set("content-type", "application/json");
        return value;
      })(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  async function ok(response: Response) {
    assert(response.ok, `${response.status}: ${await response.clone().text()}`);
    return response;
  }
  function passkeyOptions(endpoint: string, defaultHeaders: Headers) {
    return async (path: string, headers = defaultHeaders) => {
      const result = await ok(await request(endpoint + path, headers));
      return {
        data: (await result.json()) as { challenge: string },
        headers: cookies(result, headers),
      };
    };
  }
  return { cookies, request, ok, passkeyOptions };
}

export function configureSettingsTestEnv(databaseUrl: string | undefined) {
  assert(
    databaseUrl && new URL(databaseUrl).pathname.endsWith("_test"),
    "Use a disposable fresh test database",
  );
  process.env.DATABASE_TOWBAR_URL = databaseUrl;
  process.env.TOWBAR_CREDENTIALS_KEY = randomBytes(32).toString("base64");
  process.env.TOWBAR_INTERNAL_HMAC_SECRET = randomBytes(32).toString("hex");
  process.env.TOWBAR_PASSWORD_BREACH_CHECK = "false";
  // These suites run without a Temporal server, and the API only logs a
  // failed email enqueue; fail each connection attempt immediately.
  process.env.TEMPORAL_CONNECT_TIMEOUT_MS = "50";
}
