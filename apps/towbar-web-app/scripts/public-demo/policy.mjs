// New fixture endpoints are private until explicitly reviewed for public use.
const id = "[a-f0-9-]{36}";
const environment = "[a-z][a-z0-9-]{0,62}";
const stage = "(build|deployment|pre_deploy|post_deploy)";
const secrets = new RegExp(
  `^/v1/core/(?:(apps|resources|sources)/${id}|settings)/secrets/${environment}/${stage}$`,
);
const readRoutes = [
  new RegExp(`^/v1/core/apps/${id}/analytics$`),
  new RegExp(`^/v1/core/(apps|resources|servers)/${id}/metrics$`),
  /^\/v1\/core\/settings\/api-keys\/(personal|team)$/,
  new RegExp(`^/v1/core/settings/private-keys/${id}/reveal$`),
  new RegExp(`^/v1/core/servers/${id}/credentials/verifications/${id}$`),
  /^\/v1\/public\/auth\/(state|setup-status)$/,
  /^\/v1\/core\/(session|profile|sessions|version|system-health|integrations)$/,
  /^\/v1\/core\/profile\/(preferences|passkeys)$/,
  /^\/v1\/core\/team(?:\/(members|invitations))?$/,
  /^\/v1\/core\/settings\/(secrets|private-keys)$/,
  /^\/v1\/core\/github(?:\/(installation|repositories|branches))?$/,
  /^\/v1\/core\/notifications(?:\/(providers|destinations|deliveries|(?:slack|webhook|email)\/destinations))?$/,
  /^\/v1\/core\/monitoring\/(summary|incidents|vulnerabilities)$/,
  new RegExp(
    `^/v1/core/(apps|resources|servers|sources|deployments)(?:/${id})?$`,
  ),
  /^\/v1\/core\/deployments\/history$/,
  new RegExp(
    `^/v1/core/deployments/${id}/(steps|logs|events|source-revision|vulnerability-scan/findings)$`,
  ),
  new RegExp(
    `^/v1/core/(apps|resources)/${id}/(auto-deploy-control|secrets(?:/readiness)?|deployments|releases|operations|previews|storage|jobs|backup-assurance)$`,
  ),
  new RegExp(`^/v1/core/(apps|resources)/${id}/operations/${id}/events$`),
  new RegExp(
    `^/v1/core/servers/${id}/(apps|resources|deployments|capacity|checks|preparations|host-keys|orphans|credentials|monitoring(?:/(history|agent))?)$`,
  ),
  new RegExp(
    `^/v1/core/sources/${id}/(apps|resources|capacity|deployments|previews|backups|syncs(?:/${id})?|auto-deploy-control|secrets|environments(?:/${id}/manifest)?|notifications/destinations)$`,
  ),
  new RegExp(
    `^/v1/core/servers/${id}/scout-alerts(?:/(rules|incidents|settings|rules/${id}|incidents/${id}(?:/notifications)?))?$`,
  ),
  new RegExp(
    `^/v1/core/workloads/${id}/(comparison-deployments|deployment-comparison)$`,
  ),
];
const writes = [
  ["PATCH", secrets],
  [
    "POST",
    new RegExp(
      `^/v1/core/(?:(apps|resources|sources)/${id}|settings)/secrets/${environment}/${stage}/reveal(?:-all)?$`,
    ),
  ],
  ["POST", /^\/v1\/core\/sources\/(connect|discover)$/],
  [
    "POST",
    new RegExp(`^/v1/core/sources/${id}/environments(?:/${id})?/syncs$`),
  ],
  ...["POST", "PATCH", "DELETE"].map((method) => [
    method,
    new RegExp(`^/v1/core/sources/${id}/environments(?:/${id})?$`),
  ]),
  [
    "POST",
    /^\/v1\/core\/github\/actions\/(installation-url|complete-installation|retry-preview-reporting)$/,
  ],
  ["DELETE", /^\/v1\/core\/github$/],
  ["POST", /^\/v1\/core\/notifications\/read-all$/],
  ["PATCH", /^\/v1\/core\/(team|profile)$/],
  ["POST", /^\/v1\/core\/team\/(members|invitations)$/],
  ...["PATCH", "DELETE"].map((method) => [
    method,
    new RegExp(`^/v1/core/team/(members|invitations)/${id}$`),
  ]),
  ["POST", /^\/v1\/core\/settings\/api-keys\/(personal|team)$/],
  ["DELETE", new RegExp(`^/v1/core/settings/api-keys/(personal|team)/${id}$`)],
  ["POST", /^\/v1\/core\/settings\/private-keys$/],
  ...["PATCH", "DELETE"].map((method) => [
    method,
    new RegExp(`^/v1/core/settings/private-keys/${id}$`),
  ]),
  ["POST", /^\/v1\/core\/servers$/],
  ...["PATCH", "DELETE"].map((method) => [
    method,
    new RegExp(`^/v1/core/servers/${id}$`),
  ]),
  ["PATCH", new RegExp(`^/v1/core/servers/${id}/credentials$`)],
  [
    "POST",
    new RegExp(
      `^/v1/core/servers/${id}/credentials/actions/verify-private-key$`,
    ),
  ],
  ["POST", new RegExp(`^/v1/core/servers/${id}/host-keys/actions/trust$`)],
  ["DELETE", new RegExp(`^/v1/core/servers/${id}/host-keys/${id}$`)],
  ["POST", new RegExp(`^/v1/core/servers/${id}/actions/prepare$`)],
  ["PATCH", new RegExp(`^/v1/core/servers/${id}/monitoring$`)],
  [
    "POST",
    new RegExp(
      `^/v1/core/servers/${id}/monitoring/actions/(install|uninstall)$`,
    ),
  ],
  ["POST", new RegExp(`^/v1/core/servers/${id}/scout-alerts/rules$`)],
  ...["PUT", "DELETE"].map((method) => [
    method,
    new RegExp(`^/v1/core/servers/${id}/scout-alerts/rules/${id}$`),
  ]),
  ["PUT", /^\/v1\/core\/notifications\/(slack|webhook|email)\/destinations$/],
  [
    "POST",
    /^\/v1\/core\/notifications\/(slack|webhook|email)\/destinations\/test$/,
  ],
  ["POST", new RegExp(`^/v1/core/apps/${id}/actions/run-job$`)],
  [
    "POST",
    new RegExp(`^/v1/core/resources/${id}/actions/(restore|restore-cleanup)$`),
  ],
  [
    "POST",
    new RegExp(`^/v1/core/resources/${id}/operations/${id}/actions/cancel$`),
  ],
  ["POST", new RegExp(`^/v1/core/previews/${id}/actions/(deploy|delete)$`)],
  ["POST", new RegExp(`^/v1/core/deployments/${id}/actions/(retry|cancel)$`)],
  [
    "POST",
    new RegExp(
      `^/v1/core/deployments/${id}/vulnerability-scan/actions/rescan$`,
    ),
  ],
  ["PATCH", new RegExp(`^/v1/core/servers/${id}/name$`)],
  ["PUT", /^\/v1\/core\/profile\/preferences$/],
  [
    "PATCH",
    new RegExp(`^/v1/core/(apps|resources|sources)/${id}/auto-deploy-control$`),
  ],
  ["POST", /^\/v1\/core\/date-time\/localize$/],
  ["POST", /^\/v1\/core\/profile\/preferences\/(preview|range(?:\/resolve)?)$/],
  [
    "POST",
    new RegExp(
      `^/v1/core/(apps|resources)/${id}/actions/(deploy|start|stop|restart|logs|backup)$`,
    ),
  ],
  ["POST", new RegExp(`^/v1/core/servers/${id}/actions/check$`)],
  ["POST", new RegExp(`^/v1/core/sources/${id}/actions/sync$`)],
  ["POST", /^\/v1\/core\/system-health\/actions\/check$/],
];

export function allowsFixtureRequest(method, path) {
  return method === "GET"
    ? readRoutes.some((route) => route.test(path))
    : writes.some(([verb, route]) => verb === method && route.test(path));
}
