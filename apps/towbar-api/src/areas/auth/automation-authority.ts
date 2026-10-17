import { and, eq, isNull } from "drizzle-orm";
import { digestWithoutNotificationSubscriptions } from "@workspace/towbar-core";
import {
  apps,
  sourceEnvironments,
  sources,
} from "@workspace/towbar-database/schema";
import { getTowbarDatabase } from "../../infrastructure/database.js";
import { forbidden } from "../../http/errors.js";

export async function requireActiveAutomation(input: {
  workspaceId: string;
  deployableId: string;
  mappingRevision?: string;
  config?: unknown;
  preview?: boolean;
}) {
  const [target] = await getTowbarDatabase()
    .select({
      config: apps.config,
      mappingRevision: sourceEnvironments.mappingRevision,
      previewsEnabled: sourceEnvironments.previewsEnabled,
    })
    .from(apps)
    .innerJoin(sources, eq(sources.id, apps.sourceId))
    .innerJoin(
      sourceEnvironments,
      eq(sourceEnvironments.id, apps.sourceEnvironmentId),
    )
    .where(
      and(
        eq(apps.id, input.deployableId),
        eq(apps.workspaceId, input.workspaceId),
        isNull(apps.archivedAt),
        eq(apps.manifestState, "active"),
        eq(sources.status, "active"),
        eq(sources.autoDeployPaused, false),
        eq(sourceEnvironments.autoDeployPaused, false),
        isNull(sourceEnvironments.disconnectedAt),
      ),
    );
  if (
    !target ||
    (input.mappingRevision &&
      target.mappingRevision !== input.mappingRevision) ||
    (input.config &&
      digestWithoutNotificationSubscriptions(target.config) !==
        digestWithoutNotificationSubscriptions(input.config)) ||
    (input.preview && !target.previewsEnabled)
  ) {
    throw forbidden(
      "Runtime automation is paused or its repository mapping has changed",
    );
  }
}
