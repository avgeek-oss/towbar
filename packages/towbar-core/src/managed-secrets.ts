import { z } from "zod";

export const secretStages = [
  "build",
  "deployment",
  "pre_deploy",
  "post_deploy",
] as const;
export type SecretStage = (typeof secretStages)[number];
export const secretEnvironmentSchema = z
  .string()
  .max(80)
  .regex(/^(?:preview:)?[a-z][a-z0-9-]{0,62}$/);
export const secretStageSchema = z.enum(secretStages);
export const secretKeySchema = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u);
export const secretMutationSchema = z
  .object({
    expectedRevision: z.string().uuid().nullable(),
    set: z
      .unknown()
      .refine(
        (value) =>
          !(
            value &&
            typeof value === "object" &&
            Object.hasOwn(value, "__proto__")
          ),
        "The variable name __proto__ is reserved",
      )
      .pipe(
        z.record(
          secretKeySchema,
          z
            .string()
            .max(65_536)
            .refine(
              (value) => value !== "••••••••" && value !== "********",
              "Enter a new value instead of a masked placeholder",
            )
            .refine(
              (value) => !value.includes("\0"),
              "Values cannot contain null bytes",
            ),
        ),
      )
      .default({}),
    delete: z.array(secretKeySchema).max(200).default([]),
  })
  .strict()
  .superRefine((input, context) => {
    const keys = Object.keys(input.set);
    if (keys.length > 200 || (keys.length === 0 && input.delete.length === 0)) {
      context.addIssue({
        code: "custom",
        message: "Change between 1 and 200 keys per request",
      });
    }
    if (
      new Set(input.delete).size !== input.delete.length ||
      input.delete.some((key) => Object.hasOwn(input.set, key))
    ) {
      context.addIssue({
        code: "custom",
        message: "A key can only be changed once per request",
      });
    }
  });
export type SecretMutation = z.infer<typeof secretMutationSchema>;

export function applySecretMutation(
  current: Record<string, string>,
  mutation: Pick<SecretMutation, "set" | "delete">,
) {
  const next: Record<string, string> = Object.assign(
    Object.create(null),
    current,
  );
  for (const key of mutation.delete) delete next[key];
  for (const [key, value] of Object.entries(mutation.set)) next[key] = value;
  return next;
}

export function resolveSecretReferences(
  values: Record<string, string>,
  globals: Record<string, string>,
  repository: Record<string, string> = {},
) {
  const result: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(values)) {
    result[key] = value.replace(
      /\{\{\s*(globals|repo)\.([^{}]*?)\s*\}\}/gu,
      (_match, scope: string, name: string) => {
        const store = scope === "globals" ? globals : repository;
        const reference = name.trim();
        if (
          !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(reference) ||
          !Object.hasOwn(store, reference)
        ) {
          throw new Error(
            `Secret ${key} has an unavailable ${scope} reference`,
          );
        }
        return store[reference]!;
      },
    );
    if (result[key]!.length > 65_536)
      throw new Error(`Resolved secret ${key} exceeds the value size limit`);
  }
  return { ...result };
}

export function secretReferenceDependencies(local: Record<string, string>) {
  let global = false;
  let repository = false;
  for (const value of Object.values(local)) {
    if (/\{\{\s*globals\./u.test(value)) global = true;
    if (/\{\{\s*repo\./u.test(value)) repository = true;
  }
  return { global, repository };
}

export function validateSecretReferences(
  values: Record<string, string>,
  scope: "workspace" | "repository" | "app",
) {
  for (const [key, value] of Object.entries(values)) {
    const remainder = value.replace(
      /\{\{\s*(globals|repo)\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/gu,
      (_match, referenceScope: string) => {
        if (scope !== "app")
          throw new Error(
            `Secret ${key} cannot reference ${referenceScope} at this scope`,
          );
        return "";
      },
    );
    if (/\{\{\s*[A-Za-z_][A-Za-z0-9_]*\b/u.test(remainder))
      throw new Error(
        `Secret ${key} has an invalid reference. Use {{globals.KEY}} or {{repo.KEY}}`,
      );
  }
}
