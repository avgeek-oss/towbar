import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

void test("GitHub groups app previews while preserving each PR's identity and lifecycle", async (t) => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const environment = {
    DATABASE_TOWBAR_URL: "postgres://localhost/unused_test",
    TOWBAR_CREDENTIALS_KEY: Buffer.alloc(32, 1).toString("base64"),
    TOWBAR_INTERNAL_HMAC_SECRET: "test-hmac-secret".repeat(3),
  };
  const githubConfiguration = {
    appId: "1001",
    appSlug: "towbar-test",
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    webhookSecret: "test-webhook-secret",
  };
  for (const [key, value] of Object.entries(environment)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  t.mock.method(globalThis, "fetch", (url: string, init: RequestInit) => {
    if (url.endsWith("/access_tokens")) {
      return Promise.resolve(
        Response.json({
          token: "test-token",
          expires_at: "2099-01-01T00:00:00Z",
        }),
      );
    }
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    requests.push({ url, body });
    return Promise.resolve(Response.json({ id: requests.length }));
  });
  // Import after installing the transport stub: requests must never reach GitHub.
  const { createGitHubPreviewDeployment, updateGitHubPreviewDeployment } =
    await import("./client.js");
  const repository = {
    installationId: "123",
    repositoryName: "platform",
    repositoryOwner: "example-inc",
  };
  for (const pullRequestNumber of [135, 136]) {
    await createGitHubPreviewDeployment(
      {
        ...repository,
        appName: "Company Website",
        commitSha: String(pullRequestNumber).padStart(40, "0"),
        environmentUrl: `https://pr-${pullRequestNumber}.example.com`,
        pullRequestNumber,
      },
      githubConfiguration,
    );
  }
  assert.equal(requests[0]?.body.environment, "Company Website (preview)");
  assert.equal(requests[1]?.body.environment, requests[0]?.body.environment);
  assert.equal(
    requests[0]?.body.description,
    "Towbar Preview deployment for PR #135",
  );
  assert.equal(
    requests[1]?.body.description,
    "Towbar Preview deployment for PR #136",
  );
  assert.notEqual(requests[0]?.body.ref, requests[1]?.body.ref);
  assert.notDeepEqual(requests[0]?.body.payload, requests[1]?.body.payload);
  assert.equal(requests[0]?.body.transient_environment, true);
  assert.equal(requests[0]?.body.production_environment, false);

  await createGitHubPreviewDeployment(
    {
      ...repository,
      appName: "A".repeat(255),
      commitSha: "a".repeat(40),
      environmentUrl: "https://long-name.example.com",
      pullRequestNumber: 137,
    },
    githubConfiguration,
  );
  const name = String(requests[2]?.body.environment);
  assert.equal(name.length, 255);
  assert.ok(name.endsWith(" (preview)"));

  for (const [deploymentId, state] of [
    ["1", "success"],
    ["2", "success"],
    ["1", "inactive"],
  ] as const) {
    await updateGitHubPreviewDeployment(
      {
        ...repository,
        deploymentId,
        state,
        environmentUrl: `https://preview-${deploymentId}.example.com`,
      },
      githubConfiguration,
    );
    assert.equal(requests.at(-1)?.body.auto_inactive, false);
    assert.equal(requests.at(-1)?.body.state, state);
    assert.ok(
      requests.at(-1)?.url.endsWith(`/deployments/${deploymentId}/statuses`),
    );
  }
});
