import assert from "node:assert/strict";
import { test } from "node:test";
import { sourceConnectionSchema } from "./connection.js";

const repository = {
  githubInstallationId: "11111111-1111-4111-8111-111111111111",
  repositoryOwner: "example",
  repositoryName: "service",
};

void test("connection accepts more than twenty named mappings without a discovery branch", () => {
  const environments = Array.from({ length: 25 }, (_, index) => ({
    environment: `qa-${index}`,
    branch: `release/${index}`,
  }));
  assert.deepEqual(
    sourceConnectionSchema.parse({ ...repository, environments }),
    {
      ...repository,
      environments,
      provider: "github",
    },
  );
  assert.equal(
    sourceConnectionSchema.safeParse({
      ...repository,
      environments: [...environments, environments[0]],
    }).success,
    false,
  );
  assert.equal(
    sourceConnectionSchema.safeParse({ ...repository, environments: [] })
      .success,
    false,
  );
});

void test("connection rejects retired repository providers", () => {
  assert.equal(
    sourceConnectionSchema.safeParse({
      provider: "gitlab",
      integration: "gitlab",
      providerRepositoryId: "123456",
      repositoryOwner: "example",
      repositoryName: "service",
      environments: [{ environment: "production", branch: "main" }],
    }).success,
    false,
  );
});
