import assert from "node:assert/strict";
import test from "node:test";
import type { servers } from "@workspace/towbar-database/schema";
import { normalizeServerConfiguration } from "@workspace/towbar-core";
import { toPublicServer } from "./public-server.js";

void test("server public settings round trip true, false and legacy defaults without private fields", () => {
  for (const hostLogCollection of [true, false, undefined]) {
    const config = normalizeServerConfiguration({
      ip: "192.0.2.10",
      ssh: { username: "ubuntu" },
      hostLogCollection,
    });
    const now = new Date();
    const server: typeof servers.$inferSelect = {
      id: "server",
      workspaceId: "workspace",
      canonicalIp: config.ip,
      name: null,
      privateKeyId: null,
      config: { ...config, privateKey: "private-value" } as typeof config,
      configDigest: "digest",
      preparedConfigDigest: "digest",
      preparedAt: now,
      archivedAt: null,
      lastRemovedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const publicServer = toPublicServer(server);
    assert.equal(
      publicServer.config.hostLogCollection,
      hostLogCollection === true,
    );
    assert.equal(publicServer.setupStatus, "ready");
    assert.equal(JSON.stringify(publicServer).includes("private-value"), false);
    assert.deepEqual(normalizeServerConfiguration(publicServer.config), config);
  }
});
