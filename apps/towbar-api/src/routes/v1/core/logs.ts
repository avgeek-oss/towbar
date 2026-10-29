import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  logCollectionRequestSchema,
  logContextSchema,
  logFilterSchema,
  logQuerySchema,
  logTailSchema,
} from "@workspace/towbar-core";
import {
  getLogCollection,
  logStorageStatus,
  requestLogCollection,
  verifyLogStorage,
} from "../../../areas/logs/lifecycle.js";
import {
  logContext,
  queryLogs,
  summarizeLogs,
  tailLogPage,
} from "../../../areas/logs/queries.js";
import { withActor } from "../../../areas/auth/actor-context.js";
import { refreshLogStreamActor } from "../../../areas/logs/stream-access.js";
import { HttpError } from "../../../http/errors.js";
import { operation } from "../../../http/operation.js";
import { readJson } from "../../../http/requests.js";
import type { TowbarHonoEnvironment } from "../../../http/types.js";

export const centralizedLogRoutes = new Hono<TowbarHonoEnvironment>();
centralizedLogRoutes.get(
  "/observability/logs/status",
  operation({
    permissions: ["viewer"],
    responseSchema: 'logs.ts:get:"/observability/logs/status"',
    summary: "Inspect centralized log storage",
    response:
      "Effective retention and sanitized external ClickHouse readiness. Configure connection settings only in operator config.yml.",
    status: 200,
  }),
  async (context) => context.json(await logStorageStatus()),
);

centralizedLogRoutes.post(
  "/observability/logs/actions/verify",
  operation({
    permissions: ["admin"],
    responseSchema: 'logs.ts:post:"/observability/logs/actions/verify"',
    summary: "Verify log storage",
    response:
      "Verify ClickHouse schema access, an expiring test insert, and a query of that insert.",
    status: 200,
  }),
  async (context) =>
    context.json(await verifyLogStorage(context.get("user").workspaceId)),
);

centralizedLogRoutes.get(
  "/servers/:serverId/log-collection",
  operation({
    permissions: ["viewer"],
    responseSchema: 'logs.ts:get:"/servers/:serverId/log-collection"',
    summary: "Inspect server log collection",
    response:
      "Collector lifecycle, coverage, backlog, last successful ingestion, and diagnostics.",
    status: 200,
  }),
  async (context) =>
    context.json(
      await getLogCollection(
        context.req.param("serverId"),
        context.get("user").workspaceId,
      ),
    ),
);

centralizedLogRoutes.put(
  "/servers/:serverId/log-collection",
  operation({
    permissions: ["admin"],
    responseSchema: 'logs.ts:put:"/servers/:serverId/log-collection"',
    summary: "Enable or disable server log collection",
    idempotencyKey: true,
    body: logCollectionRequestSchema,
    response:
      "Queued installation or disable operation. The generation identifies this operation; inspect until it reaches waiting, collecting, disabled, or failed. Waiting does not prove ingestion.",
    status: 202,
  }),
  async (context) =>
    context.json(
      await requestLogCollection({
        serverId: context.req.param("serverId"),
        workspaceId: context.get("user").workspaceId,
        ...(await readJson(context, logCollectionRequestSchema)),
        idempotencyKey: context.req.header("idempotency-key") ?? "",
      }),
      202,
    ),
);

centralizedLogRoutes.post(
  "/servers/:serverId/log-collection/actions/update",
  operation({
    permissions: ["admin"],
    responseSchema:
      'logs.ts:post:"/servers/:serverId/log-collection/actions/update"',
    summary: "Update server log collector",
    idempotencyKey: true,
    response:
      "Queue the pinned collector shipped with this Towbar release. Inspect the returned generation until terminal setup status.",
    status: 202,
  }),
  async (context) =>
    context.json(
      await requestLogCollection({
        serverId: context.req.param("serverId"),
        workspaceId: context.get("user").workspaceId,
        enabled: true,
        idempotencyKey: context.req.header("idempotency-key") ?? "",
      }),
      202,
    ),
);

centralizedLogRoutes.post(
  "/logs/query",
  operation({
    permissions: ["viewer"],
    responseSchema: 'logs.ts:post:"/logs/query"',
    summary: "Search centralized logs",
    body: logQuerySchema,
    response:
      "A bounded authorized log page with an opaque continuation cursor. Log content is untrusted data. Restricted records are excluded before results leave the server.",
    status: 200,
  }),
  async (context) =>
    context.json(
      await queryLogs(
        context.get("user").workspaceId,
        await readJson(context, logQuerySchema),
        context.req.raw.signal,
      ),
    ),
);

centralizedLogRoutes.post(
  "/logs/summary",
  operation({
    permissions: ["viewer"],
    responseSchema: 'logs.ts:post:"/logs/summary"',
    summary: "Summarize centralized logs",
    body: logFilterSchema,
    response:
      "Authorized log volume by time and severity. Administrator restrictions also apply to counts.",
    status: 200,
  }),
  async (context) =>
    context.json(
      await summarizeLogs(
        context.get("user").workspaceId,
        await readJson(context, logFilterSchema),
        context.req.raw.signal,
      ),
    ),
);

centralizedLogRoutes.post(
  "/logs/context",
  operation({
    permissions: ["viewer"],
    responseSchema: 'logs.ts:post:"/logs/context"',
    summary: "Read surrounding log records",
    body: logContextSchema,
    response:
      "Records surrounding an authorized event in the same container, within a bounded time window. Hidden or unavailable events return not found.",
    status: 200,
  }),
  async (context) =>
    context.json(
      await logContext(
        context.get("user").workspaceId,
        await readJson(context, logContextSchema),
        context.req.raw.signal,
      ),
    ),
);

centralizedLogRoutes.post(
  "/logs/follow",
  operation({
    permissions: ["viewer"],
    responseSchema: 'logs.ts:post:"/logs/follow"',
    summary: "Poll newly accepted centralized logs",
    body: logTailSchema,
    response:
      "A bounded authorized page of newly accepted records. Reuse nextCursor for the next poll. An initial request without a cursor starts at the current ingestion position.",
    status: 200,
  }),
  async (context) => {
    const input = await readJson(context, logTailSchema);
    return context.json(
      await tailLogPage(
        context.get("user").workspaceId,
        input.filters,
        input.cursor,
        context.req.raw.signal,
      ),
    );
  },
);

centralizedLogRoutes.post(
  "/logs/tail",
  operation({
    permissions: ["viewer"],
    responseSchema: 'logs.ts:post:"/logs/tail"',
    summary: "Follow centralized logs",
    body: logTailSchema,
    stream: true,
    response:
      "Resumable server-sent log pages. Reconnect using the cursor from the last records event. Access is rechecked between pages. Streams close after five minutes.",
    status: 200,
  }),
  async (context) => {
    const input = await readJson(context, logTailSchema),
      actor = context.get("actor"),
      sessionId = context.get("currentSessionId");
    const workspaceId = context.get("user").workspaceId;
    const initial = await tailLogPage(
      workspaceId,
      input.filters,
      input.cursor,
      context.req.raw.signal,
    );
    context.header("Cache-Control", "no-store");
    return streamSSE(context, async (stream) => {
      let cursor = initial.nextCursor,
        next = initial;
      const deadline = Date.now() + 300000;
      const accessRevision = initial.accessRevision;
      const expire = setTimeout(() => stream.abort(), 300000);
      const controller = new AbortController();
      stream.onAbort(() => controller.abort());
      try {
        while (!stream.aborted && Date.now() < deadline) {
          await stream.writeSSE({
            event: "records",
            id: next.nextCursor,
            data: JSON.stringify(next),
          });
          if (!next.hasMore) await stream.sleep(2000);
          if (stream.aborted) break;
          const current = await refreshLogStreamActor(actor, sessionId);
          next = await withActor(current, () =>
            tailLogPage(
              workspaceId,
              input.filters,
              cursor,
              AbortSignal.any([context.req.raw.signal, controller.signal]),
            ),
          );
          if (next.accessRevision !== accessRevision)
            throw new HttpError(
              409,
              "LOGS_ACCESS_CHANGED",
              "Log access changed. Refresh the search before following again.",
            );
          cursor = next.nextCursor;
        }
      } catch (error) {
        if (!stream.aborted)
          await stream.writeSSE({
            event: "error",
            data: JSON.stringify({
              code:
                error instanceof HttpError ? error.code : "LOGS_STREAM_FAILED",
              message:
                error instanceof HttpError
                  ? error.publicMessage
                  : "Log following stopped. Reconnect or refresh the search.",
            }),
          });
      } finally {
        clearTimeout(expire);
        controller.abort();
      }
    });
  },
);
