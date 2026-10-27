import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";
import { createTowbarDatabase } from "@workspace/towbar-database";
import { runTowbarMigrations } from "@workspace/towbar-database/migrate";
import {
  notificationEvents,
  servers,
  users,
  workspaces,
} from "@workspace/towbar-database/schema";
import {
  listNotificationCenter,
  markAllNotificationsRead,
  notificationCenterQuery,
} from "./center.js";

const url = process.env.TOWBAR_TEST_DATABASE_URL;
void test(
  "durable notification receipts isolate users and teams, retain unread history and expire reads",
  { skip: !url },
  async () => {
    assert(url && new URL(url).pathname.endsWith("_test"));
    const admin = postgres(url, { max: 1, onnotice() {} });
    const name = `notification_${randomUUID().replaceAll("-", "")}_test`;
    const isolated = new URL(url);
    isolated.pathname = `/${name}`;
    await admin.unsafe(`create database "${name}"`);
    const connection = createTowbarDatabase(isolated.href);
    const db = connection.database;
    const client = connection.client;
    try {
      await runTowbarMigrations({
        databaseUrl: isolated.href,
        logger: { info() {}, error() {} },
      });
      const workspaceId = randomUUID(),
        otherWorkspace = randomUUID(),
        userId = randomUUID(),
        otherUser = randomUUID();
      const owner = { workspaceId, userId };
      await db.insert(workspaces).values(
        [workspaceId, otherWorkspace].map((id) => ({
          id,
          slug: id,
          name: "Notification test",
        })),
      );
      await db.insert(users).values(
        [userId, otherUser].map((id) => ({
          id,
          email: `${id}@example.test`,
          displayName: "Reader",
        })),
      );
      const serverId = randomUUID(),
        otherServer = randomUUID();
      await db.insert(servers).values(
        [
          { id: serverId, workspaceId },
          { id: otherServer, workspaceId: otherWorkspace },
        ].map((item) => ({
          ...item,
          canonicalIp: "192.0.2.1",
          configDigest: "test",
          config: {
            ip: "192.0.2.1",
            ssh: { host: "192.0.2.1", port: 22, username: "ubuntu" },
            buildConcurrency: 1,
          },
        })),
      );
      const event = (
        id: string,
        team: string = workspaceId,
        server: string = serverId,
      ) => ({
        id,
        workspaceId: team,
        serverId: server,
        dedupeKey: id,
        type: "runtime.unhealthy" as const,
        category: "health" as const,
        occurredAt: new Date("2020-01-01T00:00:00Z"),
        payload: {
          title: "Old notification",
          message: "Unread history",
          occurredAt: "2020-01-01T00:00:00Z",
          details: {},
          entity: { id: server, kind: "server" as const, name: "Server" },
          source: null,
        },
      });
      const ids: string[] = Array.from({ length: 121 }, () => randomUUID());
      await db
        .insert(notificationEvents)
        .values([
          ...ids.map((id) => event(id)),
          event(randomUUID(), otherWorkspace, otherServer),
        ]);
      // Sub-millisecond ties must not disappear across cursor pages.
      await client`update towbar_notification_events set occurred_at = '2020-01-01T00:00:00.000123Z'`;
      let page = await listNotificationCenter(
        owner,
        notificationCenterQuery.parse({ limit: 20 }),
        db,
      );
      assert.equal(page.unreadCount, 121);
      const seen = page.notifications.map((item) => item.id);
      while (page.nextCursor) {
        page = await listNotificationCenter(
          owner,
          notificationCenterQuery.parse({ limit: 20, ...page.nextCursor }),
          db,
        );
        seen.push(...page.notifications.map((item) => item.id));
      }
      assert.equal(seen.length, 121);
      assert.equal(new Set(seen).size, 121);
      assert(seen.every((id) => ids.includes(id)));
      // An event still uncommitted at the mark-all snapshot stays unread.
      const arrival = randomUUID();
      const pending = postgres(isolated.href, { max: 1 });
      try {
        const reserved = await pending.reserve();
        try {
          await reserved`begin`;
          await reserved`insert into towbar_notification_events (id, workspace_id, server_id, dedupe_key, type, category, payload, occurred_at) values (${arrival}, ${workspaceId}, ${serverId}, ${arrival}, 'runtime.unhealthy', 'health', ${JSON.stringify(event(arrival).payload)}::jsonb, now())`;
          await markAllNotificationsRead(owner, db);
          await reserved`commit`;
        } finally {
          reserved.release();
        }
      } finally {
        await pending.end();
      }
      page = await listNotificationCenter(
        owner,
        notificationCenterQuery.parse({}),
        db,
      );
      assert.equal(page.unreadCount, 1);
      assert.equal(
        page.notifications.find((item) => item.id === arrival)?.readAt,
        null,
      );
      assert.equal(
        (
          await listNotificationCenter(
            { workspaceId, userId: otherUser },
            notificationCenterQuery.parse({}),
            db,
          )
        ).unreadCount,
        122,
      );
      assert.equal(
        (
          await listNotificationCenter(
            { workspaceId: otherWorkspace, userId },
            notificationCenterQuery.parse({}),
            db,
          )
        ).unreadCount,
        1,
      );
      await client`update towbar_notification_reads set read_at = now() - interval '25 hours'`;
      const reads =
        await client`select event_id, read_at from towbar_notification_reads order by event_id`;
      await markAllNotificationsRead(owner, db);
      assert.deepEqual(
        await client`select event_id, read_at from towbar_notification_reads where event_id != ${arrival} order by event_id`,
        reads,
      );
      page = await listNotificationCenter(
        owner,
        notificationCenterQuery.parse({}),
        db,
      );
      assert.equal(page.unreadCount, 0);
      assert.deepEqual(
        page.notifications.map((item) => item.id),
        [arrival],
      );
      assert.equal(
        (
          await client`select count(*)::int as count from towbar_notification_events`
        )[0]?.count,
        123,
      );
      await runTowbarMigrations({
        databaseUrl: isolated.href,
        logger: { info() {}, error() {} },
      });
      assert.equal(
        (
          await client`select count(*)::int as count from towbar_notification_reads`
        )[0]?.count,
        122,
      );
    } finally {
      await connection.close();
      await admin.unsafe(`drop database "${name}" with (force)`);
      await admin.end();
    }
  },
);
