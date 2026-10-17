import { parseDocument } from "yaml";
import { z } from "zod";

import {
  ManifestValidationError,
  appSchema,
  digestValue,
  ipAddressSchema,
  normalizeDeploymentManifest,
  resourceSchema,
} from "./manifest.js";
import {
  isValidBranchName,
  normalizeRepositoryPath,
} from "./manifest-values.js";
import { secretKeySchema } from "./managed-secrets.js";
import {
  buildServerSelectionSchema,
  composeWorkloadSchema,
} from "./platform-expansion.js";

export const environmentNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,62}$/)
  .refine(
    (name) =>
      ![
        "preview",
        "previews",
        "__proto__",
        "constructor",
        "prototype",
      ].includes(name),
    "This environment name is reserved",
  );

export const sourceEnvironmentMappingSchema = z
  .object({
    environment: environmentNameSchema,
    branch: z
      .string()
      .min(1)
      .max(255)
      .refine(isValidBranchName, "Invalid Git branch name"),
  })
  .strict();

import { deploymentInputGroupsSchema } from "./deployment-input-schema.js";

export const repositoryManifestSchema = z
  .object({
    version: z.literal(2),
    deploymentInputs: deploymentInputGroupsSchema.optional(),
    buildServer: buildServerSelectionSchema.nullable().optional(),
    environments: z
      .record(
        environmentNameSchema,
        z
          .object({
            buildServer: buildServerSelectionSchema.nullable().optional(),
            previews: z.object({ enabled: z.boolean() }).strict().optional(),
          })
          .strict(),
      )
      .refine(
        (value) => Object.keys(value).length > 0,
        "Declare at least one environment",
      ),
  })
  .strict();

const keysSchema = z
  .array(
    secretKeySchema.refine(
      (key) => !["__proto__", "constructor", "prototype"].includes(key),
      "Reserved secret key",
    ),
  )
  .max(200)
  .refine((keys) => new Set(keys).size === keys.length, "Duplicate secret key");
export const requiredSecretsSchema = z
  .object({
    build: keysSchema.default([]),
    runtime: keysSchema.default([]),
    preDeploy: keysSchema.default([]),
    postDeploy: keysSchema.default([]),
  })
  .strict();
export type RequiredSecrets = z.infer<typeof requiredSecretsSchema>;
export const resourceRequiredSecretsSchema = requiredSecretsSchema.pick({
  runtime: true,
});
export type RepositoryManifest = z.infer<typeof repositoryManifestSchema>;
export type RepositoryFile = { path: string; content: string };

function invalid(
  file: string,
  message: string,
  path: (string | number)[] = [],
): never {
  throw new ManifestValidationError([{ message, path: [file, ...path] }]);
}

function readYaml(file: RepositoryFile): unknown {
  if (Buffer.byteLength(file.content, "utf8") > 256 * 1024) {
    invalid(file.path, "File exceeds 256 KiB");
  }
  const document = parseDocument(file.content, {
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length)
    invalid(
      file.path,
      document.errors.map((error) => error.message).join("; "),
    );
  try {
    return document.toJS({ maxAliasCount: 0 });
  } catch {
    invalid(file.path, "YAML aliases are not supported");
  }
}

function validate<T>(schema: z.ZodType<T>, value: unknown, file: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ManifestValidationError(
      result.error.issues.map((issue) => ({
        message: issue.message,
        path: [file, ...issue.path.map(String)],
      })),
    );
  }
  return result.data;
}

export function parseRepositoryManifest(content: string): RepositoryManifest {
  return validate(
    repositoryManifestSchema,
    readYaml({ path: "towbar.yml", content }),
    "towbar.yml",
  );
}

export function entityFileKind(
  filePath: string,
): "app" | "compose" | "resource" | undefined {
  if (normalizeRepositoryPath(filePath) !== filePath)
    throw new Error("Entity paths must be canonical repository-relative paths");
  if (
    [".towbar/apps/", ".towbar/resources/", ".towbar/compose/"].some((prefix) =>
      filePath.startsWith(prefix),
    )
  )
    invalid(
      filePath,
      "Use .towbar/services for services or .towbar/datastores for datastores",
    );
  if (
    filePath.startsWith(".towbar/services/") &&
    filePath.endsWith(".service.yml")
  )
    return "app";
  if (
    filePath.startsWith(".towbar/datastores/") &&
    filePath.endsWith(".datastore.yml")
  )
    return "resource";
  if (
    filePath.startsWith(".towbar/services/") &&
    filePath.endsWith(".compose.yml")
  )
    return "compose";
  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rejectUnsafeKeys(value: unknown, file: string): void {
  if (Array.isArray(value)) {
    value.forEach((item) => rejectUnsafeKeys(item, file));
  } else if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (["__proto__", "constructor", "prototype"].includes(key))
        invalid(file, `Reserved key '${key}'`);
      rejectUnsafeKeys(child, file);
    }
  }
}

export function mergeEnvironmentConfiguration(
  defaults: Record<string, unknown>,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = Object.assign(
    Object.create(null),
    defaults,
  );
  for (const [key, value] of Object.entries(overrides)) {
    const existing = result[key];
    result[key] =
      isObject(existing) && isObject(value)
        ? mergeEnvironmentConfiguration(existing, value)
        : value;
  }
  return result;
}

/** Resolve one environment only; other environment settings never enter its digest. */
// eslint-disable-next-line complexity -- The branches mirror the three versioned entity schemas and their fail-closed validation rules.
export function resolveRepositoryEnvironment(input: {
  root: string;
  files: RepositoryFile[];
  environment: string;
  branch: string;
}) {
  const root = parseRepositoryManifest(input.root);
  validate(
    sourceEnvironmentMappingSchema,
    { environment: input.environment, branch: input.branch },
    "towbar.yml",
  );
  const environment = root.environments[input.environment];
  if (!environment)
    invalid("towbar.yml", `Environment '${input.environment}' is not declared`);
  const apps: z.input<typeof appSchema>[] = [];
  const compose: z.input<typeof composeWorkloadSchema>[] = [];
  const resources: z.input<typeof resourceSchema>[] = [];
  const manifestPaths: Record<string, string[]> = Object.create(null);
  const declarations: Record<string, RequiredSecrets> = Object.create(null);
  const paths = new Set<string>();
  const identities = new Set<string>();
  if (input.files.length > 1000)
    invalid("towbar.yml", "At most 1000 entity files are supported");
  let totalBytes = 0;
  for (const file of [...input.files].sort((a, b) =>
    a.path.localeCompare(b.path),
  )) {
    const kind = entityFileKind(file.path);
    if (!kind) continue;
    if (paths.has(file.path)) invalid(file.path, "Duplicate file path");
    paths.add(file.path);
    totalBytes += Buffer.byteLength(file.content, "utf8");
    if (totalBytes > 8 * 1024 * 1024)
      invalid(file.path, "Entity files exceed 8 MiB in total");
    const value = readYaml(file);
    rejectUnsafeKeys(value, file.path);
    if (!isObject(value)) invalid(file.path, "Expected one entity object");
    const { environments, secrets, ...defaults } = value;
    const overrides = validate(
      z.record(environmentNameSchema, z.record(z.string(), z.unknown())),
      environments,
      file.path,
    );
    for (const [name, settings] of Object.entries(overrides)) {
      if (!root.environments[name])
        invalid(file.path, `Unknown environment '${name}'`, [
          "environments",
          name,
        ]);
      for (const key of [
        "id",
        "name",
        "type",
        "secrets",
        "preview",
        "environments",
      ]) {
        if (Object.hasOwn(settings, key))
          invalid(file.path, `'${key}' must be declared at entity level`, [
            "environments",
            name,
            key,
          ]);
      }
    }
    const id = validate(
      z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/),
      defaults.id,
      file.path,
    );
    const identity = `${kind}:${id}`;
    if (identities.has(identity))
      invalid(file.path, `Duplicate ${kind} id '${id}'`);
    identities.add(identity);
    const required = requiredSecretsSchema.parse(
      validate(
        kind === "resource" || kind === "compose"
          ? resourceRequiredSecretsSchema
          : requiredSecretsSchema,
        secrets ?? {},
        file.path,
      ),
    );
    const selected = overrides[input.environment];
    if (!selected) continue;
    (manifestPaths[id] ??= []).push(file.path);
    const resolved = mergeEnvironmentConfiguration(defaults, selected);
    if (kind === "app") {
      if (!Object.hasOwn(resolved, "buildServer")) {
        const inherited = Object.hasOwn(environment, "buildServer")
          ? environment.buildServer
          : root.buildServer;
        if (inherited !== undefined) resolved.buildServer = inherited;
      }
      if (resolved.buildServer === null) delete resolved.buildServer;
    }
    validate(ipAddressSchema, resolved.server, file.path);
    if (kind === "app") {
      const app = validate(appSchema, resolved, file.path);
      if (!environment.previews?.enabled) delete app.preview;
      apps.push(app);
    } else if (kind === "resource") {
      resources.push(validate(resourceSchema, resolved, file.path));
    } else {
      compose.push(validate(composeWorkloadSchema, resolved, file.path));
    }
    declarations[identity] = required;
  }
  // Existing normalization supplies defaults for container, health, image and backup settings.
  const normalized = normalizeDeploymentManifest({
    version: 2,
    source: { branch: input.branch },
    deploymentInputs: root.deploymentInputs,
    apps,
    compose,
    resources,
  });
  const manifest = {
    ...normalized,
    version: 2 as const,
    environment: input.environment,
    previewsEnabled: environment.previews?.enabled ?? false,
    requiredSecrets: declarations,
  };
  return { manifest, digest: digestValue(manifest), manifestPaths };
}
