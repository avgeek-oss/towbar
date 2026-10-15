import { listPersonalPasskeys } from "../../../areas/auth/passkeys.js";
import { Hono } from "hono";
import {
  initializeDateTimeRange,
  preferredRangeSchema,
  rangeInitializationSchema,
  resolveDateTimeRange,
} from "@workspace/towbar-core/date-time-range";
import { badRequest } from "../../../http/errors.js";
import { z } from "zod";
import { logTablePreferencesSchema } from "@workspace/towbar-core";
import { dateTimePreferencesSchema } from "@workspace/towbar-core/date-time";
import { operation } from "../../../http/operation.js";
import { readJson } from "../../../http/requests.js";
import { sessionUser } from "../../../http/session-user.js";
import { requestDateTimePreferences } from "../../../http/localization.js";
import {
  getLogTablePreferences,
  preferenceOptions,
  preferencePreview,
  updateDateTimePreferences,
  updateLogTablePreferences,
} from "../../../areas/auth/preferences.js";
import type { TowbarHonoEnvironment } from "../../../http/types.js";

export const preferenceRoutes = new Hono<TowbarHonoEnvironment>();
preferenceRoutes.get(
  "/profile/preferences/logs-table",
  operation({
    permissions: ["personal.manage"],
    browserOnly: true,
    summary: "Get log table preferences",
    response:
      "The signed-in user's latest column selection, order, custom fields and widths.",
    responseSchema: 'preferences.ts:get:"/profile/preferences/logs-table"',
  }),
  async (context) =>
    context.json({
      preferences: await getLogTablePreferences(sessionUser(context).id),
    }),
);
preferenceRoutes.put(
  "/profile/preferences/logs-table",
  operation({
    permissions: ["personal.manage"],
    browserOnly: true,
    body: logTablePreferencesSchema,
    summary: "Update log table preferences",
    response: "The signed-in user's latest log table layout.",
    responseSchema: 'preferences.ts:put:"/profile/preferences/logs-table"',
  }),
  async (context) =>
    context.json({
      preferences: await updateLogTablePreferences(
        sessionUser(context).id,
        await readJson(context, logTablePreferencesSchema),
      ),
    }),
);
preferenceRoutes.get(
  "/profile/passkeys",
  operation({
    permissions: ["personal.manage"],
    browserOnly: true,
    summary: "List personal passkeys",
    response: "Passkey names and creation dates for the signed-in user.",
    responseSchema: 'preferences.ts:get:"/profile/passkeys"',
  }),
  async (context) =>
    context.json({
      passkeys: await listPersonalPasskeys(sessionUser(context).id),
    }),
);
preferenceRoutes.post(
  "/profile/preferences/range",
  operation({
    permissions: ["personal.manage"],
    browserOnly: true,
    body: rangeInitializationSchema,
    summary: "Initialize a time range",
    response:
      "Time-range form values in the saved date/time formats and time zone.",
    responseSchema: 'preferences.ts:post:"/profile/preferences/range"',
  }),
  async (context) =>
    context.json({
      form: initializeDateTimeRange(
        requestDateTimePreferences(context),
        await readJson(context, rangeInitializationSchema),
      ),
    }),
);
preferenceRoutes.post(
  "/profile/preferences/range/resolve",
  operation({
    permissions: ["personal.manage"],
    browserOnly: true,
    body: preferredRangeSchema,
    summary: "Resolve a time range",
    response:
      "UTC range timestamps, or choices for repeated daylight-saving times.",
    responseSchema: 'preferences.ts:post:"/profile/preferences/range/resolve"',
  }),
  async (context) => {
    const input = await readJson(context, preferredRangeSchema);
    try {
      return context.json(
        resolveDateTimeRange(requestDateTimePreferences(context), input),
      );
    } catch (error) {
      throw badRequest(
        error instanceof Error ? error.message : "Invalid time range",
      );
    }
  },
);
preferenceRoutes.get(
  "/profile/preferences",
  operation({
    permissions: ["personal.manage"],
    browserOnly: true,
    summary: "Get date and time preferences",
    response:
      "Saved preferences, available formats and time zones, and a server-rendered preview.",
    responseSchema: 'preferences.ts:get:"/profile/preferences"',
  }),
  (context) => {
    const preferences = requestDateTimePreferences(context);
    return context.json({
      preferences,
      options: preferenceOptions(),
      preview: preferencePreview(preferences),
    });
  },
);

preferenceRoutes.put(
  "/profile/preferences",
  operation({
    permissions: ["personal.manage"],
    browserOnly: true,
    body: dateTimePreferencesSchema,
    summary: "Update date and time preferences",
    response: "Saved preferences and a server-rendered preview.",
    responseSchema: 'preferences.ts:put:"/profile/preferences"',
  }),
  async (context) => {
    const user = sessionUser(context);
    const preferences = await updateDateTimePreferences(
      user.id,
      await readJson(context, dateTimePreferencesSchema),
    );
    context.set("user", { ...user, dateTimePreferences: preferences });
    return context.json({
      preferences,
      preview: preferencePreview(preferences),
    });
  },
);

preferenceRoutes.post(
  "/profile/preferences/preview",
  operation({
    permissions: ["personal.manage"],
    browserOnly: true,
    body: dateTimePreferencesSchema,
    summary: "Preview date and time preferences",
    response: "A server-rendered preview without changing saved preferences.",
    responseSchema: 'preferences.ts:post:"/profile/preferences/preview"',
  }),
  async (context) =>
    context.json({
      preview: preferencePreview(
        await readJson(context, dateTimePreferencesSchema),
      ),
    }),
);

const localizationInput = z
  .object({
    timestamps: z
      .array(z.union([z.iso.datetime({ offset: true }), z.iso.date()]))
      .max(2000),
  })
  .strict();
preferenceRoutes.post(
  "/date-time/localize",
  operation({
    permissions: ["personal.manage"],
    browserOnly: true,
    body: localizationInput,
    summary: "Localize timestamps",
    response:
      "Original timestamps with server-rendered date/time labels in the signed-in user’s time zone.",
    responseSchema: 'preferences.ts:post:"/date-time/localize"',
  }),
  async (context) => context.json(await readJson(context, localizationInput)),
);
