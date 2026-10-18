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
