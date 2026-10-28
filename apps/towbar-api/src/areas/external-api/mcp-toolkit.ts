import type { Scope } from "@workspace/towbar-access";
import { z } from "zod";
import { secretKeySchema } from "@workspace/towbar-core";
import { operations } from "./catalogue.js";

// This is an intentional agent contract, independent of REST operation IDs.
// Recipes may compose reads, but each mutation performs one explicit action.
export type OperationCall = {
  method: string;
  route: string;
  path?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: unknown;
  idempotencyKey?: string;
};
export type ToolContext = {
  call: (request: OperationCall) => Promise<Record<string, unknown>>;
};
export type McpTool = {
  name: string;
  title: string;
  description: string;
  input: z.ZodType;
  readOnly: boolean;
  permissions: readonly Scope[];
  destructive: boolean;
  idempotent: boolean;
  run: (
    args: unknown,
    context: ToolContext,
  ) => Promise<Record<string, unknown>>;
};
export function tool<S extends z.ZodType>(
  name: string,
  title: string,
  description: string,
  input: S,
  run: (
    args: z.output<S>,
    context: ToolContext,
  ) => Promise<Record<string, unknown>>,
  options: Pick<McpTool, "permissions"> &
    Partial<Pick<McpTool, "readOnly" | "destructive" | "idempotent">>,
): McpTool {
  return {
    name: `towbar_${name}`,
    title,
    description,
    input,
    readOnly: true,
    destructive: false,
    idempotent: true,
    ...options,
    run: async (args, context) => await run(input.parse(args), context),
  };
}
export const id = (entity: string) =>
  z
    .uuid()
    .describe(
      `${entity} UUID returned by a Towbar discovery or inspection tool. Do not guess IDs.`,
    );
export const actionKey = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .describe(
    "Unique identifier for this intended action. Reuse exactly this value when retrying an uncertain response; use a new value for a new action.",
  );
export const page = {
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(100).default(20),
};
export const sourceId = { sourceId: id("Source") };
export const serverId = { serverId: id("Server") };
export const deploymentId = { deploymentId: id("Deployment") };
export const resourceId = { resourceId: id("Resource") };
export const workload = {
  kind: z.enum(["app", "resource"]),
  workloadId: id("App or resource"),
};
export const targets = {
  source: "sources",
  app: "apps",
  resource: "resources",
  server: "servers",
} as const;
export const workloadRoute = (kind: "app" | "resource") =>
  `/${targets[kind]}/:${kind}Id`;
export const workloadPath = (args: {
  kind: "app" | "resource";
  workloadId: string;
}) => ({ [`${args.kind}Id`]: args.workloadId });
function bodyShape(method: string, route: string) {
  const body = operations.find(
    (op) => op.method === method && op.path === route,
  )?.body;
  if (!(body instanceof z.ZodObject))
    throw new Error(`Expected object body: ${method} ${route}`);
  return {
    ...body.shape,
    ...(route.endsWith("/credentials")
      ? { set: z.record(secretKeySchema, z.string().max(65536)).default({}) }
      : {}),
  };
}
export function pageItems(items: unknown[], offset: number, limit: number) {
  return {
    items: items.slice(offset, offset + limit),
    total: items.length,
    nextOffset: offset + limit < items.length ? offset + limit : null,
  };
}
export function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null && !Array.isArray(item),
      )
    : [];
}
const inventoryFields = [
  "id",
  "name",
  "displayName",
  "repositoryName",
  "repositoryOwner",
  "fullName",
  "branch",
  "state",
  "status",
  "ip",
  "canonicalIp",
  "serverIp",
  "setupStatus",
  "runtimeState",
  "serverReady",
  "sourceId",
  "serverId",
  "kind",
  "type",
  "health",
  "githubInstallationId",
  "installationId",
];
export function inventorySummary(item: Record<string, unknown>) {
  return Object.fromEntries(
    inventoryFields.filter((key) => key in item).map((key) => [key, item[key]]),
  );
}
// Single-purpose actions can share schema/dispatch plumbing without exporting routes as tools.
export function action(
  name: string,
  title: string,
  description: string,
  method: string,
  route: string,
  pathShape: z.ZodRawShape = {},
  options: { destructive?: boolean } = {},
) {
  const op = operations.find(
    (item) => item.method === method && item.path === route,
  );
  if (!op) throw new Error(`Missing action dependency: ${method} ${route}`);
  const fields: z.ZodRawShape = op.body ? bodyShape(method, route) : {};
  const shape: z.ZodRawShape = {
    ...pathShape,
    ...fields,
    ...(op.idempotencyKey ? { idempotencyKey: actionKey } : {}),
  };
  const input = z.object(shape).strict();
  return tool(
    name,
    title,
    description,
    input,
    async (args, context) => {
      const result = await context.call({
        method,
        route,
        path: Object.fromEntries(
          Object.keys(pathShape).map((key) => [key, args[key] as string]),
        ),
        ...(op.body
          ? {
              body: Object.fromEntries(
                Object.keys(fields).map((key) => [key, args[key]]),
              ),
            }
          : {}),
        ...(op.idempotencyKey
          ? { idempotencyKey: args.idempotencyKey as string }
          : {}),
      });
      return result;
    },
    {
      readOnly: false,
      permissions: op.permissions,
      destructive: options.destructive ?? true,
      idempotent: Boolean(op.idempotencyKey),
    },
  );
}
