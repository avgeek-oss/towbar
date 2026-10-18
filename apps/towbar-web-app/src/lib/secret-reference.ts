import { TowbarApiError } from "@workspace/towbar-web-client";

export type RevealSecretReference = (
  scope: "globals" | "repo",
  key: string,
) => Promise<string>;

export function secretReferenceAt(line: string, position: number, side = 1) {
  const assignment = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/.exec(line);
  if (!assignment || position < assignment[0].length) return undefined;
  for (const match of line.matchAll(
    /\{\{\s*(globals|repo)\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g,
  )) {
    const from = match.index;
    const to = from + match[0].length;
    if (
      position >= from &&
      position <= to &&
      !(position === from && side < 0) &&
      !(position === to && side > 0)
    ) {
      return {
        from,
        to,
        scope: match[1] as "globals" | "repo",
        key: match[2]!,
      };
    }
  }
  return undefined;
}

export function secretReferenceError(
  error: unknown,
  reference: { scope: "globals" | "repo"; key: string },
) {
  if (error instanceof TowbarApiError) {
    if (error.code === "REAUTHENTICATION_REQUIRED")
      return "Confirm your identity, then hover again to view this value";
    if (error.status === 401) return "Sign in again to view this value";
    if (error.status === 403)
      return "You don't have permission to view this value";
    if (error.status === 404)
      return `${reference.scope === "repo" ? "Repository" : "Workspace"} secret ${reference.key} was not found in this stage. Check the ${reference.scope === "repo" ? "current repository" : "workspace"} secret store.`;
    if (error.status === 429)
      return "Too many preview requests. Wait a moment, then hover again.";
    if (error.code === "SECRET_DECRYPTION_FAILED")
      return "The shared secret could not be unlocked. Check the installation encryption key.";
  }
  return "Shared value could not be loaded. Move away and hover again to retry.";
}
