import { format } from "prettier";
import ts from "@typescript/typescript6";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { dateTimeLocalizationSchema } from "@workspace/towbar-core/date-time";
const project = resolve(import.meta.dirname, "../tsconfig.json");
const config = ts.readConfigFile(project, ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(
  config.config,
  ts.sys,
  resolve(import.meta.dirname, ".."),
);
const program = ts.createProgram(parsed.fileNames, parsed.options);
const diagnostics = ts
  .getPreEmitDiagnostics(program)
  .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
if (diagnostics.length) {
  throw new Error(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (file) => file,
      getCurrentDirectory: () => process.cwd(),
      getNewLine: () => "\n",
    }),
  );
}
const checker = program.getTypeChecker();
type Schema = Record<string, unknown>;
const definitions: Record<string, Schema> = {};
const references = new Map<ts.Type, string>();
function schemaFor(
  type: ts.Type,
  seen = new Set<ts.Type>(),
  depth = 0,
): Schema {
  const existing = references.get(type);
  if (existing) return { $ref: `#/components/schemas/${existing}` };
  if (depth > 15 || seen.has(type)) return {};
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return {};
  if (type.flags & ts.TypeFlags.StringLiteral)
    return { type: "string", const: (type as ts.StringLiteralType).value };
  if (type.flags & ts.TypeFlags.NumberLiteral)
    return { type: "number", const: (type as ts.NumberLiteralType).value };
  if (type.flags & ts.TypeFlags.StringLike) return { type: "string" };
  if (type.flags & ts.TypeFlags.NumberLike) return { type: "number" };
  if (type.flags & ts.TypeFlags.BooleanLike) return { type: "boolean" };
  if (type.flags & ts.TypeFlags.Null) return { type: "null" };
  const next = new Set(seen).add(type);
  if (type.isUnion()) {
    const choices = type.types
      .filter((t) => !(t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Never)))
      .map((t) => schemaFor(t, next, depth + 1));
    const unique = [
      ...new Map(choices.map((s) => [JSON.stringify(s), s])).values(),
    ];
    return unique.length === 1
      ? unique[0]!
      : unique.length
        ? { anyOf: unique }
        : {};
  }
  if (type.getSymbol()?.getName() === "Date")
    return { type: "string", format: "date-time" };
  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    const args = checker.getTypeArguments(type as ts.TypeReference);
    return {
      type: "array",
      items: args[0] ? schemaFor(args[0], next, depth + 1) : {},
    };
  }
  if (!(type.flags & ts.TypeFlags.Object) && !type.isIntersection()) return {};
  return objectSchema(type, next, depth);
}
function objectSchema(
  type: ts.Type,
  next: Set<ts.Type>,
  depth: number,
): Schema {
  const rawName =
    type.aliasSymbol?.getName() ?? type.getSymbol()?.getName() ?? "Response";
  const name = `${rawName.startsWith("__") ? "Response" : rawName.replace(/[^A-Za-z0-9]/g, "")}_${references.size + 1}`;
  references.set(type, name);
  const properties: Record<string, Schema> = {};
  const required: string[] = [];
  for (const property of type.getProperties()) {
    const location = property.valueDeclaration ?? property.declarations?.[0];
    if (!location || property.getName().startsWith("__@")) continue;
    properties[property.getName()] = schemaFor(
      checker.getTypeOfSymbolAtLocation(property, location),
      next,
      depth + 1,
    );
    if (!(property.flags & ts.SymbolFlags.Optional))
      required.push(property.getName());
  }
  const index = type.getStringIndexType();
  definitions[name] = {
    type: "object",
    ...(Object.keys(properties).length ? { properties } : {}),
    ...(required.length ? { required } : {}),
    ...(index
      ? { additionalProperties: schemaFor(index, next, depth + 1) }
      : {}),
  };
  return { $ref: `#/components/schemas/${name}` };
}
const schemas: Record<string, Schema> = {};
for (const source of program
  .getSourceFiles()
  .filter((s) => s.fileName.includes("/routes/v1/core/"))) {
  function walk(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ["get", "post", "put", "patch", "delete"].includes(
        node.expression.name.text,
      ) &&
      node.arguments.length === 3
    ) {
      const [path, metadata, handler] = node.arguments;
      if (
        metadata &&
        ts.isCallExpression(metadata) &&
        metadata.expression.getText(source) === "operation" &&
        handler &&
        path
      ) {
        const meta = metadata.arguments[0];
        if (!meta || !ts.isObjectLiteralExpression(meta)) return;
        const response = meta.properties.find(
          (p) =>
            ts.isPropertyAssignment(p) && p.name.getText(source) === "response",
        );
        if (
          !response ||
          !ts.isPropertyAssignment(response) ||
          !ts.isStringLiteral(response.initializer)
        )
          return;
        const results: Schema[] = [];
        function inspect(child: ts.Node) {
          if (
            ts.isCallExpression(child) &&
            ts.isPropertyAccessExpression(child.expression) &&
            child.expression.getText(source) === "context.json" &&
            child.arguments[0]
          )
            results.push(
              schemaFor(checker.getTypeAtLocation(child.arguments[0])),
            );
          ts.forEachChild(child, inspect);
        }
        inspect(handler);
        const key = `${source.fileName.split("/").at(-1)}:${node.expression.name.text}:${path.getText(source)}`;
        schemas[key] =
          results.length === 1
            ? results[0]!
            : results.length
              ? { anyOf: results }
              : {};
        if (results.length)
          schemas[key] = {
            allOf: [
              schemas[key],
              {
                type: "object",
                properties: {
                  localization: z.toJSONSchema(dateTimeLocalizationSchema),
                },
                required: ["localization"],
              },
            ],
          };
      }
    }
    ts.forEachChild(node, walk);
  }
  walk(source);
}
const target = resolve(
  import.meta.dirname,
  "../src/areas/external-api/response-schemas.json",
);
const output = await format(JSON.stringify({ schemas, definitions }), {
  parser: "json",
});
if (process.argv.includes("--check")) {
  if ((await readFile(target, "utf8")) !== output)
    throw new Error("API response schemas are stale. Run pnpm docs:api.");
} else await writeFile(target, output);
console.log(`Response schemas: ${Object.keys(schemas).length} handlers`);
