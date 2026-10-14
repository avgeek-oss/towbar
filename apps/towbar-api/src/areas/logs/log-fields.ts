export function parsedLogFields(object: Record<string, unknown>) {
  const result: Record<string, string> = {};
  let count = 0;
  const visit = (value: unknown, path: string[], depth: number) => {
    if (count >= 50 || depth > 8) return;
    const key = path.join(".");
    if (
      key.length > 128 ||
      /password|authorization|cookie|secret|token/iu.test(key) ||
      path.some((part) =>
        ["__proto__", "constructor", "prototype"].includes(part),
      )
    )
      return;
    if (["string", "number", "boolean"].includes(typeof value)) {
      result[key] = String(value).slice(0, 4096);
      count++;
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [name, entry] of Object.entries(value)) {
      if (count >= 50) break;
      visit(entry, [...path, name], depth + 1);
    }
  };
  const standard = new Set([
    "trace_id",
    "traceId",
    "span_id",
    "spanId",
    "message",
    "msg",
    "level",
    "severity",
  ]);
  const entries = Object.entries(object).sort(
    ([a], [b]) => Number(standard.has(b)) - Number(standard.has(a)),
  );
  for (const [key, value] of entries) {
    if (count >= 50) break;
    visit(value, [key], 1);
  }
  return result;
}
