import { randomBytes } from "node:crypto";
import { HttpError } from "../../http/errors.js";
import { getLogConfiguration, logsDocumentationUrl } from "./configuration.js";
import { ensureLogSchema, logStorage } from "./storage.js";

export async function logStorageStatus() {
  const checkedAt = new Date().toISOString();
  let retentionDays: number | null = null;
  try {
    const config = getLogConfiguration();
    if (!config)
      return {
        state: "not_configured" as const,
        reason: null,
        code: null,
        retentionDays,
        checkedAt,
        documentationUrl: logsDocumentationUrl,
      };
    retentionDays = config.retentionDays;
    await ensureLogSchema();
    return {
      state: "ready" as const,
      reason: null,
      code: null,
      retentionDays,
      checkedAt,
      documentationUrl: logsDocumentationUrl,
    };
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    return {
      state: "unavailable" as const,
      reason: error.publicMessage,
      code: error.code,
      retentionDays,
      checkedAt,
      documentationUrl: logsDocumentationUrl,
    };
  }
}

export async function verifyLogStorage(workspaceId: string) {
  const storage = logStorage();
  await ensureLogSchema(storage);
  const id = randomBytes(32).toString("hex"),
    now = new Date().toISOString();
  await storage.execute(
    "INSERT INTO log_records FORMAT JSONEachRow",
    {},
    {
      data: JSON.stringify({
        workspaceId,
        eventId: id,
        timestamp: now,
        observedAt: now,
        ingestedAt: now,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        serverId: "00000000-0000-4000-8000-000000000000",
        workloadId: "00000000-0000-4000-8000-000000000000",
        workloadName: "Storage verification",
        deploymentId: null,
        previewId: null,
        environment: "production",
        containerId: "0".repeat(64),
        service: "",
        stream: "stdout",
        severity: "info",
        body: "Towbar storage verification",
        attributes: {},
        traceId: null,
        spanId: null,
        visibility: "admin",
        truncated: false,
      }),
    },
  );
  const [row] = await storage.execute<{ count: string }>(
    "SELECT count() AS count FROM log_records WHERE workspaceId = {workspaceId:UUID} AND eventId = {eventId:String} FORMAT JSONEachRow",
    { workspaceId, eventId: id },
    { readOnly: true },
  );
  if (Number(row?.count) !== 1)
    throw new HttpError(
      503,
      "LOGS_VERIFICATION_FAILED",
      "ClickHouse accepted a verification write but it could not be queried.",
    );
  return { verified: true, checkedAt: now };
}
