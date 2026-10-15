import { Hono } from "hono";
import { z } from "zod";

import {
  serverPreparationStepDefinitions,
  serverPreparationStepLogMaxLength,
  serverPreparationStepMessageMaxLength,
} from "@workspace/towbar-core";

import {
  getServerPreparationExecutionContext,
  updateServerPreparation,
} from "../../../areas/servers/preparations.js";
import { getPreparationLogCollectorContext } from "../../../areas/logs/lifecycle.js";
import { readJson, readUuidPathParameter } from "../../../http/requests.js";

const preparationId = (value: string) =>
  readUuidPathParameter(value, "preparationId");

const stepIds = serverPreparationStepDefinitions.map((step) => step.id) as [
  (typeof serverPreparationStepDefinitions)[number]["id"],
  ...(typeof serverPreparationStepDefinitions)[number]["id"][],
];
const stepSchema = z
  .object({
    finishedAt: z.string().datetime().nullable(),
    id: z.enum(stepIds),
    log: z.string().max(serverPreparationStepLogMaxLength).optional(),
    logTruncated: z.boolean().optional(),
    message: z.string().max(serverPreparationStepMessageMaxLength).nullable(),
    startedAt: z.string().datetime().nullable(),
    status: z.enum(["waiting", "running", "succeeded", "failed"]),
    title: z.string().trim().min(1).max(100),
  })
  .strict();
const stepsSchema = z
  .array(stepSchema)
  .min(stepIds.length - 1)
  .max(stepIds.length)
  .refine(
    (steps) =>
      new Set(steps.map((step) => step.id)).size === steps.length &&
      stepIds.every(
        (id) =>
          id === "installing_log_collector" ||
          steps.some((step) => step.id === id),
      ),
    "Every server preparation step must appear once",
  );
const eventSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("running"), steps: stepsSchema }).strict(),
  z
    .object({
      result: z.record(z.string(), z.unknown()),
      status: z.literal("succeeded"),
      steps: stepsSchema,
    })
    .strict(),
  z
    .object({
      errorCode: z.string().trim().min(1).max(100),
      errorMessage: z.string().trim().min(1).max(1_000),
      status: z.literal("failed"),
      steps: stepsSchema,
    })
    .strict(),
]);

export const internalServerPreparationRoutes = new Hono();

internalServerPreparationRoutes.get(
  "/:preparationId/context",
  async (context) =>
    context.json({
      context: await getServerPreparationExecutionContext(
        preparationId(context.req.param("preparationId")),
      ),
    }),
);
internalServerPreparationRoutes.post(
  "/:preparationId/log-collector",
  async (context) =>
    context.json(
      await getPreparationLogCollectorContext(
        preparationId(context.req.param("preparationId")),
      ),
    ),
);
internalServerPreparationRoutes.post(
  "/:preparationId/events",
  async (context) => {
    const body = await readJson(context, eventSchema);
    return context.json({
      preparation: await updateServerPreparation(
        preparationId(context.req.param("preparationId")),
        body,
      ),
    });
  },
);
