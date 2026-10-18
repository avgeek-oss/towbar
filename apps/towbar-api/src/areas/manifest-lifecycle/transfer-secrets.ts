import { digestValue, requiredSecretStages } from "@workspace/towbar-core";
import type { RequiredSecrets } from "@workspace/towbar-core";
import { type SecretDatabase, readSecretValues } from "../secrets/store.js";

export async function repositoryTransferSecrets(
  database: SecretDatabase,
  input: {
    workspaceId: string;
    appId: string;
    sourceId: string;
    environment: string;
    required: RequiredSecrets;
    includePreview?: boolean;
  },
) {
  const missing = new Set<string>();
  const revisions: Array<string | null> = [];
  const environments = input.includePreview
    ? [input.environment, `preview:${input.environment}`]
    : [input.environment];
  for (const environment of environments) {
    for (const [declaration, stage] of Object.entries(requiredSecretStages)) {
      const local = await readSecretValues(
        {
          type: "app",
          id: input.appId,
          workspaceId: input.workspaceId,
          environment,
          stage,
        },
        database,
      );
      revisions.push(local.revision);
      const names = new Set(
        input.required[declaration as keyof RequiredSecrets].flatMap((key) =>
          [
            ...(local.values[key] ?? "").matchAll(
              /\{\{\s*repo\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/gu,
            ),
          ].map((match) => match[1]!),
        ),
      );
      if (!names.size) continue;
      const destination = await readSecretValues(
        {
          type: "repository",
          id: input.sourceId,
          workspaceId: input.workspaceId,
          environment: "production",
          stage,
        },
        database,
      );
      revisions.push(destination.revision);
      for (const name of names)
        if (!Object.hasOwn(destination.values, name))
          missing.add(`repo.${name} (${stage})`);
    }
  }
  return { missing: [...missing].sort(), revision: digestValue(revisions) };
}
