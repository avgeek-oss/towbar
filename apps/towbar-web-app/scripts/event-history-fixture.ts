import type { IncomingMessage, ServerResponse } from "node:http";
import {
  notificationEventTypes,
  notificationCategoryForEvent,
  notificationCategories,
} from "@workspace/towbar-core";
import type { TowbarUser } from "@workspace/towbar-web-client";
import { fixtureJson } from "./fixture-localization.ts";

export function eventHistoryFixture(
  getUser: () => TowbarUser | null | undefined,
) {
  const now = Date.now();
  const id = (group: number, index: number) =>
    `e${group}111111-1111-4111-8111-${String(index + 1).padStart(12, "0")}`;
  const providers = ["slack", "smtp", "discord", "telegram", "webhook"];
  const states = ["succeeded", "pending", "retrying", "failed", "delivering"];
  const targets = [
    {
      id: "31111111-1111-4111-8111-222222222222",
      name: "Example Website",
      kind: "app",
    },
    {
      id: "41111111-1111-4111-8111-111111111111",
      name: "Primary Postgres",
      kind: "resource",
    },
    {
      id: "21111111-1111-4111-8111-111111111111",
      name: "192.0.2.10",
      kind: "server",
    },
  ];
  const deliveries = Array.from({ length: 48 }, (_, index) => {
    const provider = providers[index % providers.length]!;
    const state = states[Math.floor(index / providers.length) % states.length]!;
    const type = notificationEventTypes[index % notificationEventTypes.length]!;
    const target =
      type.startsWith("deployment.") || type.startsWith("preview.")
        ? targets[0]!
        : type.startsWith("backup.") || type.startsWith("restore.")
          ? targets[1]!
          : type.startsWith("server.")
            ? targets[2]!
            : targets[index % targets.length]!;
    const createdAt = new Date(now - index * 60_000).toISOString();
    return {
      id: id(5, index),
      eventId: id(6, index),
      destinationId: id(7, index),
      provider,
      destination:
        provider === "slack"
          ? "CTOWBARALERTS"
          : provider === "smtp"
            ? "operations@example.com"
            : provider === "telegram"
              ? "-100123456789 / Topic 2"
              : provider === "discord"
                ? "discord.com"
                : "hooks.example.com",
      destinationDeleted: index === 9 ? createdAt : null,
      type,
      category: notificationCategoryForEvent(type),
      title: type
        .split(".")
        .join(" ")
        .replace(/^./, (letter) => letter.toUpperCase()),
      entityId: target.kind === "server" ? target.id : id(2, index),
      entityName: target.name,
      targetId: target.id,
      sourceId: null,
      serverId: target.kind === "server" ? target.id : null,
      state,
      attemptCount: state === "pending" ? 0 : state === "retrying" ? 2 : 1,
      cycle: 1,
      errorCode:
        state === "failed"
          ? "AUTHENTICATION_FAILED"
          : state === "retrying"
            ? "RATE_LIMITED"
            : null,
      nextAttemptAt:
        state === "retrying" ? new Date(now + 60_000).toISOString() : null,
      lastAttemptedAt: state === "pending" ? null : createdAt,
      createdAt,
      deliveredAt: state === "succeeded" ? createdAt : null,
    };
  });
  function send(response: ServerResponse, payload: unknown, status = 200) {
    response.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    response.end(fixtureJson(response, payload));
    return true;
  }
  return (request: IncomingMessage, response: ServerResponse, url: URL) => {
    if (!["/v1/core/notifications/deliveries"].includes(url.pathname))
      return false;
    if (!getUser() || getUser()?.workspaceRole !== "admin")
      return send(
        response,
        { error: { message: "Only admins can view event history." } },
        getUser() ? 403 : 401,
      );
    if (request.method !== "GET")
      return send(response, { error: { message: "Method not allowed" } }, 405);
    const q = url.searchParams,
      search = (q.get("search") ?? "").trim().toLowerCase();
    const limit = Number(q.get("limit") ?? 25);
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      search.length > 200 ||
      (url.pathname.endsWith("/deliveries") &&
        q.has("category") &&
        ![...notificationCategories, "test", "backupsAndRestores"].includes(
          q.get("category")!,
        )) ||
      Boolean(q.get("before")) !== Boolean(q.get("beforeId"))
    )
      return send(
        response,
        { error: { message: "Invalid history query" } },
        400,
      );
    const filtered = deliveries.filter(
      (delivery) =>
        (!q.get("entityId") || q.get("entityId") === delivery.targetId) &&
        (!q.get("provider") || q.get("provider") === delivery.provider) &&
        (!q.get("state") || q.get("state") === delivery.state) &&
        (!q.get("category") ||
          (q.get("category") === "backupsAndRestores"
            ? delivery.category === "backups" ||
              delivery.category === "restores"
            : q.get("category") === "deploymentFailures"
              ? delivery.type === "deployment.failed" ||
                delivery.type === "preview.failed"
              : q.get("category") === delivery.category)) &&
        (!search ||
          [
            delivery.type,
            delivery.title,
            delivery.entityName,
            delivery.id,
          ].some((value) => value.toLowerCase().includes(search))),
    );
    const rows = filtered.filter(
      (row) =>
        !q.get("before") ||
        row.createdAt < q.get("before")! ||
        (row.createdAt === q.get("before") && row.id < q.get("beforeId")!),
    );
    const items = rows.slice(0, limit),
      last = items.at(-1);
    return send(response, {
      items,
      nextCursor:
        rows.length > limit && last
          ? { before: last.createdAt, beforeId: last.id }
          : null,
    });
  };
}
