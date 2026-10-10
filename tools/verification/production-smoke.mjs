import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

const api = process.env.VERIFY_API_URL;
const app = process.env.VERIFY_APP_URL;
assert.ok(
  api && app,
  "The disposable production runner must supply setup context",
);
for (const endpoint of [api, app]) {
  const url = new URL(endpoint);
  assert.equal(
    url.hostname,
    "127.0.0.1",
    "Production smoke tests only target loopback",
  );
  assert.equal(url.protocol, "http:");
}
assert.notEqual(api, app, "API and dashboard must have separate origins");
const cookies = new Map();
async function request(path, data, origin = app) {
  const response = await fetch(`${api}${path}`, {
    method: data === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      // The isolated stack uses loopback HTTP; forwarding Secure cookies here
      // tests the API session, not a browser's HTTPS or cookie policy.
      Cookie: [...cookies]
        .map(([name, value]) => `${name}=${value}`)
        .join("; "),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  });
  const setCookies = response.headers.getSetCookie();
  for (const cookie of setCookies) {
    const pair = cookie.split(";", 1)[0];
    const separator = pair.indexOf("=");
    cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
  return { status: response.status, body: await response.json(), setCookies };
}
function check(name, condition) {
  assert.ok(condition, name);
  console.log(`PASS ${name}`);
}

const setupPage = await fetch(`${app}/setup`, {
  signal: AbortSignal.timeout(15_000),
});
const setupHtml = await setupPage.text();
check(
  "Production web application renders setup",
  setupPage.status === 200 && setupHtml.includes("Towbar"),
);
check(
  "Dashboard advertises the separate API origin",
  setupHtml.includes('name="towbar-api-origin"') && setupHtml.includes(api),
);
const [
  webHealth,
  apiHealth,
  webApiRoute,
  apiSetupRoute,
  webMcpRoute,
  apiMcpRoute,
] = await Promise.all([
  fetch(`${app}/health`, { signal: AbortSignal.timeout(15_000) }),
  fetch(`${api}/health`, { signal: AbortSignal.timeout(15_000) }),
  fetch(`${app}/v1/public/auth/setup-status`, {
    signal: AbortSignal.timeout(15_000),
  }),
  fetch(`${api}/setup`, { signal: AbortSignal.timeout(15_000) }),
  fetch(`${app}/v1/mcp`, { signal: AbortSignal.timeout(15_000) }),
  fetch(`${api}/v1/mcp`, { signal: AbortSignal.timeout(15_000) }),
]);
check(
  "Dashboard and API health endpoints respond separately",
  webHealth.ok && apiHealth.ok,
);
check("Dashboard does not route API requests", webApiRoute.status === 404);
check("API does not route dashboard pages", apiSetupRoute.status === 404);
check(
  "MCP belongs to the API origin",
  webMcpRoute.status === 404 &&
    apiMcpRoute.status === 404 &&
    webMcpRoute.headers.get("content-type")?.includes("text/html") &&
    apiMcpRoute.headers.get("content-type")?.includes("application/json"),
);
const preflight = await fetch(`${api}/v1/public/auth/setup-status`, {
  method: "OPTIONS",
  headers: { Origin: app, "Access-Control-Request-Method": "GET" },
  signal: AbortSignal.timeout(15_000),
});
check(
  "API permits credentialed requests from the dashboard origin",
  preflight.ok &&
    preflight.headers.get("access-control-allow-origin") === app &&
    preflight.headers.get("access-control-allow-credentials") === "true",
);
let response = await request("/v1/public/auth/setup-status");
check(
  "Fresh database requires setup",
  response.status === 200 && response.body.setupRequired === true,
);
response = await request("/v1/core/team");
check("Anonymous team access is denied", response.status === 401);

const password = `${randomBytes(24).toString("base64url")}Aa1!`;
const data = {
  setupSecret: process.env.VERIFY_SETUP_SECRET,
  teamName: "Disposable Verification Team",
  displayName: "Verification Admin",
  email: "verification@example.invalid",
  password,
  confirmPassword: password,
  dateTimePreferences: {
    dateFormat: "day-short-month-year",
    timeFormat: "24-hour",
    timeZone: "UTC",
  },
};
response = await request(
  "/v1/public/auth/setup",
  data,
  "https://untrusted.example.invalid",
);
check("Cross-origin setup is rejected", response.status === 403);
response = await request("/v1/public/auth/setup", {
  ...data,
  setupSecret: "incorrect-installation-secret",
});
check("Setup rejects incorrect installation proof", response.status === 403);
response = await request("/v1/public/auth/setup", data);
check(
  "Production setup creates the first administrator",
  response.status === 201,
);
check(
  "Session cookies stay on the API host",
  response.setCookies.some(
    (cookie) =>
      /httponly/i.test(cookie) &&
      /samesite=lax/i.test(cookie) &&
      !/\bdomain=/i.test(cookie),
  ),
);
response = await request("/v1/public/auth/state");
check(
  "Authenticated session has the admin role",
  response.status === 200 && response.body.user?.workspaceRole === "admin",
);
response = await request("/v1/core/team");
check(
  "Team settings persist in the production database",
  response.status === 200 && response.body.team?.name === data.teamName,
);
response = await request("/v1/core/team/members");
check("Administrator can read the membership list", response.status === 200);
response = await request("/v1/public/auth/setup-status");
check(
  "Setup closes after the first administrator",
  response.status === 200 && response.body.setupRequired === false,
);
response = await request("/v1/public/auth/setup", data);
check("The setup ceremony cannot be replayed", response.status === 409);
