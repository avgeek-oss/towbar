import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { format as formatWithPrettier } from "prettier";
import { stringify } from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(root, "docs/api-reference/openapi.json");
const collectionPath = path.join(root, "postman/collections/Towbar API");
const check = process.argv.includes("--check");
const methods = ["get", "post", "put", "patch", "delete", "head", "options"];
const categoryOrder = [
  "Repositories",
  "Apps",
  "Resources",
  "Servers",
  "Deployments",
  "Previews",
  "Workspace",
  "Integrations",
];
const sectionOrder = [
  "Overview",
  "Sync & manifest",
  "Environments",
  "Auto-deploy",
  "Deployments",
  "Runtime & logs",
  "Storage",
  "Scheduled jobs",
  "Backups & restores",
  "Previews",
  "Inventory",
  "Capacity",
  "Monitoring",
  "Scout Agent",
  "Scout Alerts",
  "Performance comparisons",
  "Checks & preparation",
  "Credentials & trust",
  "Maintenance",
  "Cleanup",
  "Progress & logs",
  "Actions",
  "Security scans",
  "Secrets",
  "Shared secrets",
  "System health",
  "Identity",
  "Connections",
  "GitHub",
  "AWS",
  "GCP",
  "Lifecycle",
];

const source = JSON.parse(await readFile(sourcePath, "utf8"));

function stableId(value) {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function safeName(value) {
  const name = value
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
  return name.slice(0, 120) || "Request";
}

function yaml(value) {
  return stringify(value, {
    lineWidth: 100,
    minContentWidth: 24,
    defaultStringType: "PLAIN",
    defaultKeyType: "PLAIN",
  });
}

function dereference(value) {
  if (!value?.$ref) return value;
  const parts = value.$ref.replace(/^#\//, "").split("/");
  return parts.reduce((current, part) => current?.[part], source);
}

function sampleString(schema, name) {
  const normalizedName = name?.toLowerCase() ?? "";
  if (schema.format === "uuid" || normalizedName.endsWith("id"))
    return "00000000-0000-4000-8000-000000000000";
  if (schema.format === "date-time") return "2026-01-01T00:00:00.000Z";
  if (schema.format === "date") return "2026-01-01";
  if (schema.format === "email") return "admin@example.com";
  if (schema.format === "uri" || schema.format === "url")
    return "https://example.com";
  if (schema.format === "hostname") return "example.com";
  if (schema.format === "ipv4" || normalizedName === "ip") return "192.0.2.10";
  if (normalizedName.includes("environment")) return "production";
  if (normalizedName === "stage") return "runtime";
  if (normalizedName.includes("branch")) return "main";
  if (normalizedName.includes("owner")) return "example-inc";
  if (normalizedName.includes("repository")) return "example-app";
  if (normalizedName.includes("fingerprint")) return "SHA256:replace-me";
  if (normalizedName.includes("publickey")) return "ssh-ed25519 replace-me";
  if (normalizedName.includes("privatekey")) return "replace-me";
  if (normalizedName.includes("confirmation")) return "replace-me";
  if (normalizedName.includes("reason"))
    return "Requested through the Towbar API";
  if (normalizedName.includes("url")) return "https://example.com";
  if (normalizedName.includes("name")) return "example";
  return "string";
}

function sample(schemaValue, name) {
  const schema = dereference(schemaValue) ?? {};
  if (schema.example !== undefined) return schema.example;
  if (schema.examples?.length) return schema.examples[0];
  if (schema.default !== undefined) return schema.default;
  if (schema.const !== undefined) return schema.const;
  if (schema.enum?.length) return schema.enum[0];

  const choice = [...(schema.oneOf ?? []), ...(schema.anyOf ?? [])]
    .map(dereference)
    .find((entry) => entry?.type !== "null");
  if (choice) return sample(choice, name);

  if (schema.allOf?.length) {
    return Object.assign(
      {},
      ...schema.allOf.map((entry) => sample(entry, name)).filter(Boolean),
    );
  }

  const type = Array.isArray(schema.type)
    ? schema.type.find((entry) => entry !== "null")
    : schema.type;
  if (type === "object" || schema.properties) {
    return Object.fromEntries(
      Object.entries(schema.properties ?? {}).map(([key, value]) => [
        key,
        sample(value, key),
      ]),
    );
  }
  if (type === "array") return [sample(schema.items, name)];
  if (type === "integer" || type === "number") return schema.minimum ?? 1;
  if (type === "boolean") return true;
  if (type === "null") return null;
  return sampleString(schema, name);
}

function parameterValue(parameter) {
  const schema = dereference(parameter.schema) ?? {};
  if (parameter.example !== undefined) return parameter.example;
  if (schema.default !== undefined) return schema.default;
  if (schema.const !== undefined) return schema.const;
  if (schema.enum?.length) return schema.enum[0];
  if (parameter.required) return sample(schema, parameter.name);
  return "";
}

const operations = [];
for (const [openApiPath, pathItem] of Object.entries(source.paths)) {
  for (const method of methods) {
    const operation = pathItem[method];
    if (!operation || operation.deprecated) continue;
    const tag = operation.tags?.[0] ?? "Other / Overview";
    const [category, section = "Overview"] = tag.split(" / ");
    operations.push({
      category,
      section,
      method: method.toUpperCase(),
      openApiPath,
      operation,
      parameters: [
        ...(pathItem.parameters ?? []),
        ...(operation.parameters ?? []),
      ].map(dereference),
    });
  }
}

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "towbar-postman-"));
const generatedPath = path.join(temporaryRoot, "Towbar API");

async function writeYaml(relativePath, value, generated = false) {
  const destination = path.join(generatedPath, relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  const comment = generated
    ? "# Generated from docs/api-reference/openapi.json. Run pnpm postman:generate to update.\n"
    : "";
  const content = await formatWithPrettier(`${comment}${yaml(value)}`, {
    filepath: destination,
  });
  await writeFile(destination, content);
}

const pathVariableNames = [
  ...new Set(
    operations.flatMap(({ parameters }) =>
      parameters
        .filter((parameter) => parameter.in === "path")
        .map((parameter) => parameter.name),
    ),
  ),
].sort();

await writeYaml(
  ".resources/definition.yaml",
  {
    $kind: "collection",
    id: stableId("towbar-api-collection"),
    description: `${source.info.description}\n\nTowbar exposes the REST API only on HTTPS installations. Select the Towbar API environment, set baseUrl to your Towbar URL followed by /v1/api, and enter your API key as a local environment value.`,
    variables: {
      ...Object.fromEntries(pathVariableNames.map((name) => [name, ""])),
    },
    auth: [
      {
        id: stableId("towbar-api-bearer-auth"),
        type: "bearer",
        name: "Towbar API key",
        credentials: { token: "{{apiKey}}" },
      },
    ],
  },
  true,
);

function orderedNames(names, preferredOrder) {
  return [...new Set(names)].sort((left, right) => {
    const leftIndex = preferredOrder.indexOf(left);
    const rightIndex = preferredOrder.indexOf(right);
    if (leftIndex === -1 && rightIndex === -1) return left.localeCompare(right);
    if (leftIndex === -1) return 1;
    if (rightIndex === -1) return -1;
    return leftIndex - rightIndex;
  });
}

const categoryNames = orderedNames(
  operations.map(({ category }) => category),
  categoryOrder,
);
for (const [categoryIndex, category] of categoryNames.entries()) {
  const categoryOperations = operations.filter(
    (operation) => operation.category === category,
  );
  await writeYaml(path.join(safeName(category), ".resources/definition.yaml"), {
    $kind: "collection",
    order: (categoryIndex + 1) * 1000,
  });

  const sectionNames = orderedNames(
    categoryOperations.map(({ section }) => section),
    sectionOrder,
  );
  for (const [sectionIndex, section] of sectionNames.entries()) {
    const sectionOperations = categoryOperations.filter(
      (operation) => operation.section === section,
    );
    const folder = path.join(safeName(category), safeName(section));
    await writeYaml(path.join(folder, ".resources/definition.yaml"), {
      $kind: "collection",
      order: (sectionIndex + 1) * 1000,
    });

    for (const [requestIndex, entry] of sectionOperations.entries()) {
      const { method, openApiPath, operation, parameters } = entry;
      const queryParameters = parameters.filter(
        (parameter) => parameter.in === "query",
      );
      const headerParameters = parameters.filter(
        (parameter) => parameter.in === "header",
      );
      const pathParameters = parameters.filter(
        (parameter) => parameter.in === "path",
      );
      const requestPath = openApiPath.replace(
        /\{([^}]+)\}/g,
        (_match, name) => `:${name}`,
      );
      const query = queryParameters.length
        ? `?${queryParameters
            .map(
              (parameter) =>
                `${encodeURIComponent(parameter.name)}=${encodeURIComponent(String(parameterValue(parameter)))}`,
            )
            .join("&")}`
        : "";
      const jsonContent = operation.requestBody?.content?.["application/json"];
      const headers = {
        Accept: "application/json",
        ...Object.fromEntries(
          headerParameters.map((parameter) => [
            parameter.name,
            String(parameterValue(parameter)),
          ]),
        ),
        ...(jsonContent ? { "Content-Type": "application/json" } : {}),
      };
      const request = {
        $kind: "http-request",
        id: stableId(`${method} ${openApiPath}`),
        description: operation.description || operation.summary || "",
        url: `{{baseUrl}}${requestPath}${query}`,
        method,
        headers,
        ...(queryParameters.length
          ? {
              queryParams: queryParameters.map((parameter) => ({
                key: parameter.name,
                value: String(parameterValue(parameter)),
                ...(parameter.description
                  ? { description: parameter.description }
                  : {}),
              })),
            }
          : {}),
        ...(pathParameters.length
          ? {
              pathVariables: pathParameters.map((parameter) => ({
                key: parameter.name,
                value: `{{${parameter.name}}}`,
                description: parameter.description
                  ? `Required. ${parameter.description}`
                  : "Required.",
              })),
            }
          : {}),
        ...(jsonContent
          ? {
              body: {
                type: "json",
                content: JSON.stringify(
                  sample(jsonContent.schema, "request"),
                  null,
                  2,
                ),
              },
            }
          : {}),
        order: (requestIndex + 1) * 1000,
      };
      await writeYaml(
        path.join(folder, `${safeName(operation.summary)}.request.yaml`),
        request,
      );
    }
  }
}

async function files(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    () => [],
  );
  const found = [];
  for (const entry of entries) {
    const relativePath = path.join(prefix, entry.name);
    if (entry.isDirectory()) {
      found.push(
        ...(await files(path.join(directory, entry.name), relativePath)),
      );
    } else {
      found.push(relativePath);
    }
  }
  return found.sort();
}

async function compareDirectories(expected, actual) {
  const expectedFiles = await files(expected);
  const actualFiles = await files(actual);
  const paths = [...new Set([...expectedFiles, ...actualFiles])].sort();
  const changed = [];
  for (const relativePath of paths) {
    const [expectedContent, actualContent] = await Promise.all([
      readFile(path.join(expected, relativePath), "utf8").catch(() => null),
      readFile(path.join(actual, relativePath), "utf8").catch(() => null),
    ]);
    if (expectedContent !== actualContent) changed.push(relativePath);
  }
  return changed;
}

if (check) {
  const changed = await compareDirectories(generatedPath, collectionPath);
  await rm(temporaryRoot, { recursive: true, force: true });
  if (changed.length) {
    console.error("Postman collection is out of date:");
    for (const relativePath of changed) console.error(`- ${relativePath}`);
    console.error("Run pnpm postman:generate and commit the generated files.");
    process.exit(1);
  }
  console.log(`Postman collection is current (${operations.length} requests).`);
} else {
  await mkdir(path.dirname(collectionPath), { recursive: true });
  await rm(collectionPath, { recursive: true, force: true });
  await rename(generatedPath, collectionPath);
  await rm(temporaryRoot, { recursive: true, force: true });
  console.log(
    `Generated ${operations.length} Postman requests from ${sourcePath}.`,
  );
}
