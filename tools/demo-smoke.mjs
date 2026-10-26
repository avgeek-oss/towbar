import assert from "node:assert/strict";

const origin = process.argv[2] ?? "http://localhost:4880";
const serverPath = "/v1/core/servers/21111111-1111-4111-8111-111111111111";
const appPath = "/v1/core/apps/31111111-1111-4111-8111-222222222222";
const cookies = new Set();
async function call(path, cookie, method = "GET", body) {
  return fetch(`${origin}${path}`, {
    method,
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(method === "GET" ? {} : { origin }),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function start() {
  const response = await call("/__demo/start", null, "POST");
  assert.equal(response.status, 201, await response.clone().text());
  const cookie = response.headers.get("set-cookie").split(";")[0];
  cookies.add(cookie);
  return cookie;
}
try {
  assert.equal((await call("/health")).status, 200);
  assert.equal((await call("/")).headers.get("location"), "/demo");
  const welcome = await call("/demo");
  assert.match(await welcome.text(), /Explore Towbar Control Plane/);
  const a = await start(),
    b = await start();
  const prefetch = await fetch(`${origin}/services`, {
    headers: {
      cookie: a,
      rsc: "1",
      "next-router-prefetch": "1",
      "next-router-segment-prefetch": "/_tree",
    },
  });
  assert.equal(prefetch.status, 200);
  assert.match(prefetch.headers.get("content-type"), /text\/x-component/);
  assert.equal(prefetch.headers.get("cache-control"), "private, no-store");
  // Next 16.4 serializes the segment tree as [["children",{"s":"services",...}]]
  // where 16.3 used {"children":["services",...]}; accept both shapes.
  assert.match(await prefetch.text(), /"children"(?::\[|,\{"s":)"services"/);
  const dashboardHtml = await (await call("/services", a)).text();
  assert.match(dashboardHtml, /name="towbar-api-origin"/);
  assert(dashboardHtml.includes(`content="${origin}"`));
  const before = (await (await call(serverPath, b)).json()).server.name;
  assert.equal(
    (
      await call(`${serverPath}/name`, a, "PATCH", {
        name: "Demo smoke visitor A",
      })
    ).status,
    200,
  );
  assert.equal(
    (await (await call(serverPath, a)).json()).server.name,
    "Demo smoke visitor A",
  );
  assert.equal((await (await call(serverPath, b)).json()).server.name, before);
  for (const path of [
    "/",
    "/services",
    "/datastores",
    "/servers",
    "/deployments",
    "/settings/api-keys",
    "/settings/mcp",
    "/team-settings/api-keys",
  ])
    assert.equal((await call(path, a)).status, 200, path);
  const missingPage = await call("/demo-smoke-missing-page", a);
  const missingPageHtml = await missingPage.text();
  assert.match(missingPageHtml, /Page not found/);
  const errorIllustration = await call("/scout/mascot-worried.png", a);
  assert.equal(errorIllustration.status, 200);
  assert.match(errorIllustration.headers.get("content-type"), /image\/png/);
  assert.equal(
    (
      await call("/v1/core/settings/api-keys/personal", a, "POST", {
        name: "Incomplete demo key",
        access: "read",
      })
    ).status,
    400,
  );
  const createdKey = await call(
    "/v1/core/settings/api-keys/personal",
    a,
    "POST",
    {
      name: "Demo smoke inert key",
      access: "read",
      includeAdmin: false,
      expiresAt: null,
    },
  );
  assert.equal(createdKey.status, 201);
  const { token: sampleToken } = await createdKey.json();
  assert.match(sampleToken, /^twb_fixture_only_/);
  const bearerOnly = await fetch(`${origin}/v1/core/apps`, {
    headers: { authorization: `Bearer ${sampleToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(bearerOnly.status, 401);
  const { keys } = await (
    await call("/v1/core/settings/api-keys/personal", a)
  ).json();
  const mcpConnection = keys.find((key) => key.tokenType === "mcp-oauth");
  assert.equal(mcpConnection.oauthClientName, "ChatGPT");
  assert.equal(mcpConnection.oauthClientLogo, "openai");
  assert.equal(
    Date.parse(mcpConnection.expiresAt) - Date.parse(mcpConnection.createdAt),
    30 * 86400_000,
  );
  assert.equal((await call("/v1/oauth/authorize", a)).status, 403);
  for (const path of [
    "/v1/core/apps",
    "/v1/core/resources",
    "/v1/core/servers",
    "/v1/core/sources",
    "/v1/core/deployments/history",
    "/v1/core/system-health",
    "/v1/core/monitoring/summary",
  ])
    assert.equal((await call(path, a)).status, 200, path);
  for (const path of [
    `${appPath}/terminal`,
    "/v1/public/auth/identity/sign-in/email",
    "/v1/mcp",
    "/v1/oauth/token",
  ])
    assert.equal(
      (
        await call(path, a, "POST", {
          url: "http://169.254.169.254/latest/meta-data",
          secret: "smoke-dummy",
        })
      ).status,
      403,
      path,
    );
  assert.equal(
    (await call("/_next/image?url=http://169.254.169.254/latest/meta-data", a))
      .status,
    403,
  );
  const secretPath = `${appPath}/secrets/production/deployment`;
  const revealed = await call(`${secretPath}/reveal`, a, "POST", {
    key: "SESSION_SECRET",
  });
  assert.equal(revealed.status, 200);
  const originalSecret = await revealed.json();
  assert.equal(originalSecret.value, "demo-only-session-secret");
  assert.equal(
    (
      await call(secretPath, a, "PATCH", {
        expectedRevision: originalSecret.revision,
        set: { SESSION_SECRET: "smoke-visitor-a" },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await (
        await call(`${secretPath}/reveal`, b, "POST", { key: "SESSION_SECRET" })
      ).json()
    ).value,
    originalSecret.value,
  );
  const deployed = await call(`${appPath}/actions/deploy`, a, "POST");
  assert.equal(deployed.status, 202);
  const { deployment } = await deployed.json();
  assert.equal(
    (await call(`/v1/core/deployments/${deployment.id}`, b)).status,
    404,
  );
  await new Promise((resolve) => setTimeout(resolve, 6500));
  assert.equal(
    (await (await call(`/v1/core/deployments/${deployment.id}`, a)).json())
      .deployment.state,
    "succeeded",
  );
  const reset = await call("/__demo/reset", a, "POST");
  assert.equal(reset.status, 201);
  const fresh = reset.headers.get("set-cookie").split(";")[0];
  cookies.add(fresh);
  assert.equal(
    (
      await (
        await call(`${secretPath}/reveal`, fresh, "POST", {
          key: "SESSION_SECRET",
        })
      ).json()
    ).value,
    originalSecret.value,
  );
  assert.equal((await call(serverPath, a)).status, 401);
  assert.equal(
    (await (await call(serverPath, fresh)).json()).server.name,
    before,
  );
  assert.equal((await call(serverPath, b)).status, 200);
  console.info(
    "Demo smoke passed: current UI, isolated mutations, simulated deployment, forbidden operations, reset and revocation.",
  );
} finally {
  for (const cookie of cookies) await call("/__demo/session", cookie, "DELETE");
}
