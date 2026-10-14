import { logStorageConfigurationSchema } from "@workspace/towbar-core";
import { HttpError } from "../../http/errors.js";

export const logsDocumentationUrl =
  "https://www.towbar.dev/docs/operate/centralized-logs";

export function parseLogConfiguration(raw: string | undefined) {
  if (!raw?.trim()) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new HttpError(
      503,
      "LOGS_CONFIG_INVALID",
      "The observability.logs YAML configuration is invalid.",
    );
  }
  const result = logStorageConfigurationSchema.safeParse(value);
  if (!result.success)
    throw new HttpError(
      503,
      "LOGS_CONFIG_INVALID",
      `Check observability.logs.${result.error.issues[0]?.path.join(".") ?? "clickhouse"} in config.yml.`,
    );
  return result.data;
}

export function getLogConfiguration() {
  return parseLogConfiguration(process.env.TOWBAR_LOGS_CONFIG_JSON);
}

export function requireLogConfiguration() {
  const config = getLogConfiguration();
  if (!config)
    throw new HttpError(
      503,
      "LOGS_NOT_CONFIGURED",
      "Connect ClickHouse in config.yml to enable log collection.",
    );
  return config;
}
