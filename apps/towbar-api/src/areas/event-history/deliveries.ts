import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  notificationCategorySchema,
  notificationDeliveryStateSchema,
  notificationProviderSchema,
} from "@workspace/towbar-core";
import {
  apps,
  notificationDeliveries,
  notificationEvents,
} from "@workspace/towbar-database/schema";
import { getTowbarDatabase } from "../../infrastructure/database.js";
import { requireActor } from "../auth/actor-context.js";
import {
  manifestNotificationAppId,
  manifestNotificationLabels,
} from "../notifications/manifest-destinations.js";
import {
  cursorTimestamp,
  historyCursor,
  historyPage,
  historyQueryShape,
  pairedCursor,
  searchPattern,
} from "./query.js";

export const deliveriesQuery = z
  .object({
    ...historyQueryShape,
    provider: notificationProviderSchema.optional(),
    category: z
      .union([
        notificationCategorySchema,
        z.enum(["backupsAndRestores", "test"]),
      ])
      .optional(),
    state: notificationDeliveryStateSchema.optional(),
    entityId: z.string().uuid().optional(),
  })
  .refine(pairedCursor, "A cursor needs both before and beforeId");

export async function listNotificationDeliveries(
  input: z.infer<typeof deliveriesQuery> & {
    workspaceId: string;
  },
) {
  requireActor(input.workspaceId, ["admin"]);
  const search = searchPattern(input.search);
  const rows = await getTowbarDatabase()
    .select({
      id: notificationDeliveries.id,
      eventId: notificationEvents.id,
      destinationId: notificationDeliveries.destinationKey,
      provider: notificationDeliveries.provider,
      type: notificationEvents.type,
      category: notificationEvents.category,
      title: sql<string>`${notificationEvents.payload}->>'title'`,
      entityId: sql<string>`${notificationEvents.payload}->'entity'->>'id'`,
      entityName: sql<string>`${notificationEvents.payload}->'entity'->>'name'`,
      targetId: sql<string | null>`coalesce(
        ${notificationEvents.payload}->'details'->>'deployableId',
        ${notificationEvents.payload}->'entity'->>'id'
      )`,
      sourceId: notificationEvents.sourceId,
      serverId: notificationEvents.serverId,
      state: notificationDeliveries.state,
      attemptCount: notificationDeliveries.attemptCount,
      cycle: notificationDeliveries.cycle,
      errorCode: notificationDeliveries.lastErrorCode,
      nextAttemptAt: notificationDeliveries.nextAttemptAt,
      lastAttemptedAt: notificationDeliveries.lastAttemptedAt,
      createdAt: notificationDeliveries.createdAt,
      deliveredAt: notificationDeliveries.deliveredAt,
      cursorTime: cursorTimestamp(notificationDeliveries.createdAt),
    })
    .from(notificationDeliveries)
    .innerJoin(
      notificationEvents,
      and(
        eq(notificationEvents.id, notificationDeliveries.eventId),
        eq(notificationEvents.workspaceId, input.workspaceId),
      ),
    )
    .where(
      and(
        input.entityId
          ? or(
              sql`${notificationEvents.payload}->'details'->>'deployableId' = ${input.entityId}`,
              sql`${notificationEvents.payload}->'entity'->>'id' = ${input.entityId}`,
            )
          : undefined,
        input.provider
          ? eq(notificationDeliveries.provider, input.provider)
          : undefined,
        input.state ? eq(notificationDeliveries.state, input.state) : undefined,
        input.category === "backupsAndRestores"
          ? inArray(notificationEvents.category, ["backups", "restores"])
          : input.category === "deploymentFailures"
            ? inArray(notificationEvents.type, [
                "deployment.failed",
                "preview.failed",
              ])
            : input.category
              ? eq(notificationEvents.category, input.category)
              : undefined,
        historyCursor(
          notificationDeliveries.createdAt,
          notificationDeliveries.id,
          input,
        ),
        input.search
          ? or(
              ilike(notificationEvents.type, search),
              ilike(sql`${notificationEvents.payload}->>'title'`, search),
              ilike(
                sql`${notificationEvents.payload}->'entity'->>'name'`,
                search,
              ),
              ilike(sql`${notificationDeliveries.id}::text`, search),
            )
          : undefined,
      ),
    )
    .orderBy(
      desc(notificationDeliveries.createdAt),
      desc(notificationDeliveries.id),
    )
    .limit(input.limit + 1);
  const page = historyPage(rows, input.limit);
  const manifestAppIds = [
    ...new Set(
      page.items
        .map((row) => manifestNotificationAppId(row.destinationId))
        .filter((id): id is string => id !== null),
    ),
  ];
  const manifestLabels = new Map<string, string>();
  if (manifestAppIds.length) {
    const owners = await getTowbarDatabase()
      .select({ id: apps.id, config: apps.config })
      .from(apps)
      .where(
        and(
          eq(apps.workspaceId, input.workspaceId),
          inArray(apps.id, manifestAppIds),
        ),
      );
    for (const owner of owners)
      for (const [id, label] of manifestNotificationLabels(
        owner.id,
        owner.config.notifications,
      ))
        manifestLabels.set(id, label);
  }
  return {
    ...page,
    items: page.items.map((row) => ({
      ...row,
      destination: manifestLabels.get(row.destinationId) ?? row.destinationId,
    })),
  };
}
