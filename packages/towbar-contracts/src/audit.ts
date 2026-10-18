export const auditEventIcons = [
  "team",
  "member",
  "invitation",
  "email",
  "account",
  "shield",
  "api-key",
  "private-key",
  "secrets",
  "repository",
  "branch",
  "automation",
  "server",
  "terminal",
  "scout",
  "alert",
  "restore",
  "cleanup",
] as const;
export type AuditEventIcon = (typeof auditEventIcons)[number];

/** Stable audit slugs are part of the event history contract. Never reuse a slug. */
export const auditEventCatalog = {
  "workload.retirement.removal_requested": {
    icon: "cleanup",
    label: "Retired workload removal requested",
    metadata: ["reason", "manifestId", "operationCount"],
  },
  "workload.ownership.transferred": {
    icon: "repository",
    label: "Workload repository changed",
    metadata: ["previousSourceId", "sourceId", "manifestId"],
  },
  "integration.created": {
    icon: "api-key",
    label: "Integration created",
    metadata: ["provider", "revision"],
  },
  "integration.updated": {
    icon: "api-key",
    label: "Integration updated",
    metadata: ["provider", "revision"],
  },
  "integration.disconnected": {
    icon: "api-key",
    label: "Integration disconnected",
    metadata: ["provider", "remoteRevocation", "revision"],
  },
  "integration.verified": {
    icon: "api-key",
    label: "Integration verified",
    metadata: ["provider", "revision"],
  },
  "integration.tested": {
    icon: "api-key",
    label: "Integration tested",
    metadata: ["provider", "revision"],
  },
  "integration.test_failed": {
    icon: "alert",
    label: "Integration test failed",
    metadata: ["provider", "revision"],
  },
  "integration.token_refreshed": {
    icon: "api-key",
    label: "Integration token refreshed",
    metadata: ["provider", "revision"],
  },
  "integration.credential_revealed": {
    icon: "api-key",
    label: "Integration credential revealed",
    metadata: ["field", "provider", "revision"],
  },
  "team.updated": { icon: "team", label: "Team updated", metadata: [] },
  "member.created": {
    icon: "member",
    label: "Member added",
    metadata: ["role"],
  },
  "member.updated": {
    icon: "member",
    label: "Member updated",
    metadata: ["name"],
  },
  "member.role-changed": {
    icon: "member",
    label: "Member role changed",
    metadata: ["previousRole", "role"],
  },
  "member.removed": { icon: "member", label: "Member removed", metadata: [] },
  "invitation.created": {
    icon: "invitation",
    label: "Invitation created",
    metadata: ["role"],
  },
  "invitation.accepted": {
    icon: "invitation",
    label: "Invitation accepted",
    metadata: [],
  },
  "invitation.revoked": {
    icon: "invitation",
    label: "Invitation revoked",
    metadata: [],
  },
  "email.change-requested": {
    icon: "email",
    label: "Email change requested",
    metadata: [],
  },
  "email.changed": { icon: "email", label: "Email changed", metadata: [] },
  "account.signed-up": {
    icon: "account",
    label: "Account signed up",
    metadata: [],
  },
  "account.signed-in": {
    icon: "account",
    label: "Account signed in",
    metadata: [],
  },
  "account.operator-recovery": {
    icon: "account",
    label: "Account recovered by operator",
    metadata: [
      "mfaReset",
      "passkeysRemoved",
      "emailChanged",
      "personalKeysRevoked",
    ],
  },
  "account.operator-mfa-reset": {
    icon: "shield",
    label: "Two-factor authentication reset by operator",
    metadata: [
      "mfaReset",
      "passkeysRemoved",
      "emailChanged",
      "personalKeysRevoked",
    ],
  },
  "api-key.created": {
    icon: "api-key",
    label: "API key created",
    metadata: ["scope", "access", "includeAdmin", "expiresAt"],
  },
  "api-key.revoked": {
    icon: "api-key",
    label: "API key revoked",
    metadata: ["scope"],
  },
  "private-key.created": {
    icon: "private-key",
    label: "Private key created",
    metadata: ["algorithm", "generated"],
  },
  "private-key.updated": {
    icon: "private-key",
    label: "Private key updated",
    metadata: ["keyMaterialChanged"],
  },
  "private-key.deleted": {
    icon: "private-key",
    label: "Private key deleted",
    metadata: [],
  },
  "secrets.updated": {
    icon: "secrets",
    label: "Secrets updated",
    metadata: ["environment", "stage", "revision"],
  },
  "secrets.revealed": {
    icon: "secrets",
    label: "Secrets revealed",
    metadata: ["environment", "stage", "revision", "key", "keyCount"],
  },
  "source.connection.changed": {
    icon: "repository",
    label: "Repository connection changed",
    metadata: ["from", "to", "previousConnectionId", "connectionId"],
  },
  "source.connected": {
    icon: "repository",
    label: "Repository connected",
    metadata: ["environments"],
  },
  "source.environment.connected": {
    icon: "repository",
    label: "Repository environment connected",
    metadata: ["environment", "branch"],
  },
  "source.environment.branch_updated": {
    icon: "branch",
    label: "Repository branch updated",
    metadata: ["environment", "previousBranch", "branch"],
  },
  "source.removed": {
    icon: "repository",
    label: "Repository removed",
    metadata: ["transfers", "retirements", "conflicts"],
  },
  "source.environment.disconnected": {
    icon: "repository",
    label: "Repository environment disconnected",
    metadata: ["environment", "transfers", "retirements", "conflicts"],
  },
  "environment.automation-updated": {
    icon: "automation",
    label: "Environment automation updated",
    metadata: ["paused", "mappingRevision"],
  },
  "server.credentials.verified": {
    icon: "server",
    label: "Server credentials verified",
    metadata: ["revision"],
  },
  "server.removed": { icon: "server", label: "Server removed", metadata: [] },
  "server.terminal.opened": {
    icon: "terminal",
    label: "Terminal connected",
    metadata: ["connectionId", "reason"],
  },
  "server.terminal.closed": {
    icon: "terminal",
    label: "Terminal disconnected",
    metadata: ["connectionId", "reason"],
  },
  "monitoring.retention_updated": {
    icon: "scout",
    label: "Scout retention updated",
    metadata: ["retentionDays"],
  },
  "monitoring.install_requested": {
    icon: "scout",
    label: "Scout installation requested",
    metadata: ["generation"],
  },
  "logs.install_requested": {
    icon: "scout",
    label: "Log collection installation requested",
    metadata: ["generation", "version"],
  },
  "logs.disable_requested": {
    icon: "scout",
    label: "Log collection disabled",
    metadata: ["generation"],
  },
  "monitoring.uninstall_requested": {
    icon: "scout",
    label: "Scout removal requested",
    metadata: ["generation"],
  },
  "scout.rule_created": {
    icon: "alert",
    label: "Alert rule created",
    metadata: ["ruleId"],
  },
  "scout.rule_updated": {
    icon: "alert",
    label: "Alert rule updated",
    metadata: ["ruleId"],
  },
  "scout.rule_deleted": {
    icon: "alert",
    label: "Alert rule deleted",
    metadata: ["ruleId"],
  },
  "resource.restore.requested": {
    icon: "restore",
    label: "Resource restore requested",
    metadata: ["backupId", "operationId", "reason"],
  },
  "resource.restore.cancel_requested": {
    icon: "restore",
    label: "Resource restore cancellation requested",
    metadata: ["operationId"],
  },
  "resource.backup.cancel_requested": {
    icon: "restore",
    label: "Backup cancellation requested",
    metadata: ["operationId"],
  },
  "resource.restore.succeeded": {
    icon: "restore",
    label: "Resource restore succeeded",
    metadata: ["operationId", "outcome", "reason"],
  },
  "resource.restore.failed": {
    icon: "restore",
    label: "Resource restore failed",
    metadata: ["operationId", "outcome", "reason"],
  },
  "resource.restore.cancelled": {
    icon: "restore",
    label: "Resource restore cancelled",
    metadata: ["operationId", "outcome", "reason"],
  },
  "resource.restore_cleanup.requested": {
    icon: "cleanup",
    label: "Restore cleanup requested",
    metadata: ["operationId", "restoreId"],
  },
  "resource.restore_cleanup.succeeded": {
    icon: "cleanup",
    label: "Restore cleanup succeeded",
    metadata: ["operationId", "restoreId", "cleanedVolumes", "skippedVolumes"],
  },
  "resource.restore_cleanup.failed": {
    icon: "cleanup",
    label: "Restore cleanup failed",
    metadata: ["operationId", "restoreId", "cleanedVolumes", "skippedVolumes"],
  },
  "resource.restore_cleanup.cancelled": {
    icon: "cleanup",
    label: "Restore cleanup cancelled",
    metadata: ["operationId", "restoreId", "cleanedVolumes", "skippedVolumes"],
  },
} as const satisfies Record<
  string,
  {
    label: string;
    icon: AuditEventIcon;
    metadata: readonly string[];
  }
>;

export type AuditEventSlug = keyof typeof auditEventCatalog;
export type AuditMetadata = Record<string, string | number | boolean | null>;
export function isAuditEventSlug(value: string): value is AuditEventSlug {
  return Object.hasOwn(auditEventCatalog, value);
}
export const auditEventDefinitions = Object.entries(auditEventCatalog)
  .map(([slug, definition]) => ({
    slug: slug as AuditEventSlug,
    label: definition.label,
    icon: definition.icon,
  }))
  .sort((a, b) => a.label.localeCompare(b.label));

/** An allowlist keeps credential values and raw provider responses out of audit history. */
export function auditEventMetadata(
  slug: string,
  metadata: AuditMetadata,
): AuditMetadata {
  if (!isAuditEventSlug(slug)) return {};
  const allowed: readonly string[] = auditEventCatalog[slug].metadata;
  return Object.fromEntries(
    Object.entries(metadata)
      .filter(
        ([key, value]) =>
          (allowed.includes(key) ||
            [
              "tokenType",
              "oauthClientId",
              "oauthClientName",
              "oauthClientTrust",
            ].includes(key)) &&
          (value === null ||
            typeof value === "boolean" ||
            (typeof value === "number" && Number.isFinite(value)) ||
            typeof value === "string"),
      )
      .map(([key, value]) => [
        key,
        typeof value === "string" ? value.slice(0, 2000) : value,
      ]),
  );
}
