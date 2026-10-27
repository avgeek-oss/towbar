import { z } from "zod";

import { parseCredentialsMasterKey } from "@workspace/towbar-core";

function optionalEnvironmentString(schema: z.ZodString) {
  return z.preprocess(
    (value) => (value === "" ? undefined : value),
    schema.optional(),
  );
}

const publicOrigin = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      url.origin === value &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    );
  }, "Expected an HTTPS origin or loopback HTTP origin");

const envSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(4_020),
    TOWBAR_INTERNAL_API_PORT: z.coerce
      .number()
      .int()
      .min(1)
      .max(65_535)
      .default(4_023),
    TOWBAR_LOGS_CONFIG_JSON: z.string().optional(),
    DATABASE_TOWBAR_URL: z.string().url(),
    TOWBAR_CREDENTIALS_KEY: z.string().superRefine((value, context) => {
      try {
        parseCredentialsMasterKey(value);
      } catch (error) {
        context.addIssue({
          code: "custom",
          message:
            error instanceof Error
              ? error.message
              : "Invalid credential encryption key",
        });
      }
    }),
    TOWBAR_INTERNAL_HMAC_SECRET: z.string().min(32),
    TOWBAR_APP_BASE_URL: publicOrigin.default("http://localhost:4021"),
    TOWBAR_API_BASE_URL: publicOrigin.default("http://localhost:4020"),
    TOWBAR_VULNERABILITY_SCANNING_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    TOWBAR_VULNERABILITY_SCAN_MAX_AGE_HOURS: z.coerce
      .number()
      .int()
      .min(1)
      .max(720)
      .default(168),
    TOWBAR_API_RATE_LIMIT_MAX: z.coerce
      .number()
      .int()
      .min(1)
      .max(100000)
      .default(60),
    TOWBAR_API_RATE_LIMIT_WINDOW_SECONDS: z.coerce
      .number()
      .int()
      .min(1)
      .max(86400)
      .default(60),
    TOWBAR_PASSWORD_BREACH_CHECK: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
    TOWBAR_PASSWORD_VERIFY_CONCURRENCY: z.coerce
      .number()
      .int()
      .min(1)
      .max(8)
      .default(2),
    TOWBAR_PASSWORD_VERIFY_QUEUE_LIMIT: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(16),
    TEMPORAL_ADDRESS: z.string().min(1).default("127.0.0.1:7233"),
    TEMPORAL_NAMESPACE: z.string().min(1).default("default"),
    TEMPORAL_API_KEY: optionalEnvironmentString(z.string().min(1)),
    // How long a Temporal client connection may take before enqueueing gives
    // up. The default is the Temporal SDK's own; tests without a Temporal
    // server lower it so tolerated enqueue failures do not wait 10 s each.
    TEMPORAL_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(1).default(10_000),
    SOURCE_COMMIT: z.string().min(7).default("development"),
    TOWBAR_COMMIT_SHA: optionalEnvironmentString(
      z.string().regex(/^[a-f0-9]{40}$/u),
    ),
  })
  .superRefine((env, context) => {
    if (
      new URL(env.TOWBAR_APP_BASE_URL).protocol === "https:" &&
      new URL(env.TOWBAR_API_BASE_URL).protocol !== "https:"
    )
      context.addIssue({
        code: "custom",
        path: ["TOWBAR_API_BASE_URL"],
        message: "An HTTPS dashboard requires an HTTPS API origin",
      });
  });

type TowbarEnv = z.infer<typeof envSchema>;

let cachedEnv: TowbarEnv | undefined;

export function getEnv() {
  cachedEnv ??= envSchema.parse(process.env);
  return cachedEnv;
}

export function getAllowedOrigins() {
  const env = getEnv();
  return new Set([new URL(env.TOWBAR_APP_BASE_URL).origin]);
}
