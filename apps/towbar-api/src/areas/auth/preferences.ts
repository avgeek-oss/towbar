import { eq } from "drizzle-orm";
import { users } from "@workspace/towbar-database/schema";
import {
  type DateTimePreferences,
  availableTimeZones,
  createDateTimeFormatter,
  dateFormatOptions,
  dateTimePreferencesSchema,
  timeFormatOptions,
} from "@workspace/towbar-core/date-time";
import { getTowbarDatabase } from "../../infrastructure/database.js";
import { notFound } from "../../http/errors.js";
import {
  type LogTablePreferences,
  logTablePreferencesSchema,
} from "@workspace/towbar-core";

export async function getLogTablePreferences(userId: string) {
  const [user] = await getTowbarDatabase()
    .select({ preferences: users.logTablePreferences })
    .from(users)
    .where(eq(users.id, userId));
  if (!user) throw notFound("User");
  return user.preferences;
}

export async function updateLogTablePreferences(
  userId: string,
  input: LogTablePreferences,
) {
  const preferences = logTablePreferencesSchema.parse(input);
  const [updated] = await getTowbarDatabase()
    .update(users)
    .set({ logTablePreferences: preferences, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning({ preferences: users.logTablePreferences });
  if (!updated) throw notFound("User");
  return updated.preferences;
}

export function preferenceOptions() {
  return {
    dateFormats: dateFormatOptions,
    timeFormats: timeFormatOptions,
    timeZones: availableTimeZones(),
  };
}

export function preferencePreview(
  preferences: DateTimePreferences,
  instant = new Date().toISOString(),
) {
  return { instant, display: createDateTimeFormatter(preferences)(instant)! };
}

export async function updateDateTimePreferences(
  userId: string,
  input: DateTimePreferences,
) {
  const preferences = dateTimePreferencesSchema.parse(input);
  const [updated] = await getTowbarDatabase()
    .update(users)
    .set({ dateTimePreferences: preferences, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning({ preferences: users.dateTimePreferences });
  if (!updated) throw notFound("User");
  return updated.preferences;
}
