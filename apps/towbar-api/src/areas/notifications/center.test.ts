import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { notificationCenterQuery } from "./center.js";

void test("notification cursors require paired, valid bounds", () => {
  assert.equal(
    notificationCenterQuery.safeParse({ beforeId: randomUUID() }).success,
    false,
  );
  assert.equal(
    notificationCenterQuery.safeParse({ limit: 101 }).success,
    false,
  );
  assert.equal(
    notificationCenterQuery.safeParse({ userId: randomUUID() }).success,
    false,
  );
});
