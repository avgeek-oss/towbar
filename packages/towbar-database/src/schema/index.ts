import {
  boolean,
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  defaultDateTimePreferences,
  type DateTimePreferences,
} from "@workspace/towbar-core/date-time";
import { deploymentStates } from "@workspace/towbar-core/temporal";
import type { LogTablePreferences } from "@workspace/towbar-core";
import type {
  DeferredAutomaticDeployment,
  DomainHandoff,
  NotificationCategory,
  NotificationEventPayload,
  NotificationEventType,
  PersistedResourceOperationRequest,
  ResourceOperationResult,
  EncryptedCredential,
  ManifestIssue,
  ManifestReconciliation,
  NormalizedDeployable,
  NormalizedDeploymentManifest,
  NormalizedServer,
  RequiredSecrets,
  BackupAssuranceCheck,
  RestoreOperationPhase,
  ServerPreparationStep,
  VulnerabilitySeverityTotals,
  ScoutAlertCondition,
  IntegrationScope,
  IntegrationProvider,
} from "@workspace/towbar-core";
import { deploymentEnvironments } from "@workspace/towbar-core/preview";

export const workspaceRoleEnum = pgEnum("towbar_workspace_role", [
  "admin",
  "member",
  "viewer",
]);
export const sourceStatusEnum = pgEnum("towbar_source_status", [
  "active",
  "archived",
]);
export const sourceSyncStatusEnum = pgEnum("towbar_source_sync_status", [
  "queued",
  "running",
  "succeeded",
  "failed",
]);
export const checkStatusEnum = pgEnum("towbar_check_status", [
  "queued",
  "running",
  "succeeded",
  "failed",
]);
export type CheckStatus = (typeof checkStatusEnum.enumValues)[number];
export const credentialVerificationStatusEnum = pgEnum(
  "towbar_credential_verification_status",
  ["unverified", "verified", "failed"],
);
export const deploymentStateEnum = pgEnum(
  "towbar_deployment_state",
  deploymentStates,
);
export const deploymentEnvironmentEnum = pgEnum(
  "towbar_deployment_environment",
  deploymentEnvironments,
);
export const deploymentKindEnum = pgEnum("towbar_deployment_kind", [
  "deploy",
  "rollback",
]);
export const deploymentStepStatusEnum = pgEnum(
  "towbar_deployment_step_status",
  ["waiting", "running", "succeeded", "failed", "skipped"],
);
export const releaseStatusEnum = pgEnum("towbar_release_status", [
  "current",
  "previous",
  "superseded",
]);
export const deployableKindEnum = pgEnum("towbar_deployable_kind", [
  "app",
  "compose",
  "postgres",
  "mysql",
  "mariadb",
  "mongodb",
  "redis",
  "dragonfly",
  "keydb",
  "clickhouse",
]);
export const previewEnvironmentStatusEnum = pgEnum(
  "towbar_preview_environment_status",
  ["building", "healthy", "failed", "deleting", "cleanup_failed", "deleted"],
);
export const previewReportDeliveryStatusEnum = pgEnum(
  "towbar_preview_report_delivery_status",
  ["pending", "published", "failed"],
);
export const resourceOperationTypeEnum = pgEnum(
  "towbar_resource_operation_type",
  [
    "backup",
    "capture_logs",
    "run_job",
    "cleanup_orphans",
    "restart",
    "restore",
    "restore_cleanup",
    "start",
    "stop",
  ],
);
export const resourceOperationStateEnum = pgEnum(
  "towbar_resource_operation_state",
  ["queued", "running", "succeeded", "failed", "cancelled"],
);
export const backupAssuranceStatusEnum = pgEnum(
  "towbar_backup_assurance_status",
  ["missing", "stale", "not_restore_ready", "restore_ready"],
);
export const runtimeDesiredStateEnum = pgEnum("towbar_runtime_desired_state", [
  "running",
  "stopped",
]);
export const runtimeObservedStateEnum = pgEnum(
  "towbar_runtime_observed_state",
  ["missing", "running", "stopped", "unknown"],
);
export const runtimeHealthStateEnum = pgEnum("towbar_runtime_health_state", [
  "healthy",
  "none",
  "starting",
  "unhealthy",
  "unknown",
]);
export const runtimeDriftStateEnum = pgEnum("towbar_runtime_drift_state", [
  "drifted",
  "in_sync",
  "unknown",
]);
export const notificationProviderEnum = pgEnum("towbar_notification_provider", [
  "slack",
  "smtp",
  "discord",
  "telegram",
  "webhook",
]);
export const notificationDeliveryStateEnum = pgEnum(
  "towbar_notification_delivery_state",
  ["pending", "delivering", "retrying", "succeeded", "failed"],
);
export const notificationAttemptStateEnum = pgEnum(
  "towbar_notification_attempt_state",
  ["running", "succeeded", "retryable_failure", "terminal_failure"],
);
export const vulnerabilityScanStateEnum = pgEnum(
  "towbar_vulnerability_scan_state",
  ["pending", "running", "clean", "findings", "failed"],
);
export const vulnerabilitySeverityEnum = pgEnum(
  "towbar_vulnerability_severity",
  ["critical", "high", "medium", "low", "unknown"],
);
export const users = pgTable(
  "towbar_users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: varchar("email", { length: 320 }).notNull(),
    displayName: varchar("display_name", { length: 120 }).notNull(),
    logTablePreferences: jsonb(
      "log_table_preferences",
    ).$type<LogTablePreferences>(),
    dateTimePreferences: jsonb("date_time_preferences")
      .$type<DateTimePreferences>()
      .default(defaultDateTimePreferences)
      .notNull(),
    emailVerified: boolean("email_verified").default(false).notNull(),
    image: text("image"),
    twoFactorEnabled: boolean("two_factor_enabled").default(false).notNull(),
    mustChangePassword: boolean("must_change_password")
      .default(false)
      .notNull(),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("uq_towbar_users_email").on(table.email),
    check(
      "towbar_users_email_normalized",
      sql`${table.email} = lower(trim(${table.email}))`,
    ),
  ],
);

export const authAccounts = pgTable(
  "towbar_auth_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
    }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
    }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_towbar_auth_accounts_user").on(table.userId),
    uniqueIndex("uq_towbar_auth_account_provider").on(
      table.providerId,
      table.accountId,
    ),
  ],
);

export const authRateLimitBuckets = pgTable(
  "towbar_auth_rate_limit_buckets",
  {
    keyHash: varchar("key_hash", { length: 64 }).primaryKey(),
    attempts: integer("attempts").default(0).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("idx_towbar_auth_rate_limit_expires").on(table.expiresAt)],
);

export const sessions = pgTable(
  "towbar_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    activeOrganizationId: uuid("active_organization_id"),
    authenticatedAt: timestamp("authenticated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("uq_towbar_sessions_token").on(table.token),
    index("idx_towbar_sessions_user_id").on(table.userId),
    index("idx_towbar_sessions_expires_at").on(table.expiresAt),
  ],
);

export const authVerifications = pgTable(
  "towbar_auth_verifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("idx_towbar_verification_identifier").on(table.identifier)],
);

export const authPasskeys = pgTable(
  "towbar_auth_passkeys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 120 }),
    publicKey: text("public_key").notNull(),
    credentialID: text("credential_id").notNull(),
    counter: integer("counter").notNull(),
    deviceType: text("device_type").notNull(),
    backedUp: boolean("backed_up").notNull(),
    transports: text("transports"),
    aaguid: text("aaguid"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_towbar_passkey_user").on(table.userId),
    uniqueIndex("uq_towbar_passkey_credential").on(table.credentialID),
  ],
);

export const emailChanges = pgTable(
  "towbar_email_changes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    previousEmail: varchar("previous_email", { length: 320 }).notNull(),
    newEmail: varchar("new_email", { length: 320 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [uniqueIndex("uq_towbar_email_change_user").on(table.userId)],
);

export const authRecoveryCodes = pgTable("towbar_auth_recovery_codes", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  codeHashes: jsonb("code_hashes").$type<string[]>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const workspaces = pgTable(
  "towbar_workspaces",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    slug: varchar("slug", { length: 80 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    description: varchar("description", { length: 500 }),
    logo: text("logo"),
    metadata: text("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [uniqueIndex("uq_towbar_workspaces_slug").on(table.slug)],
);

export const workspaceMembers = pgTable(
  "towbar_workspace_members",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: workspaceRoleEnum("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("uq_towbar_workspace_members_identity").on(
      table.workspaceId,
      table.userId,
    ),
    index("idx_towbar_workspace_members_user_id").on(table.userId),
  ],
);

export const workspaceInvitations = pgTable(
  "towbar_workspace_invitations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    email: varchar("email", { length: 320 }).notNull(),
    role: workspaceRoleEnum("role").notNull(),
    inviterId: uuid("inviter_id")
      .notNull()
      .references(() => users.id),
    status: text("status")
      .$type<"pending" | "accepted" | "rejected" | "canceled">()
      .default("pending")
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("uq_towbar_pending_invitation")
      .on(table.workspaceId, table.email)
      .where(sql`${table.status} = 'pending'`),
    check(
      "towbar_invitation_email_normalized",
      sql`${table.email} = lower(trim(${table.email}))`,
    ),
  ],
);

export const apiKeys = pgTable(
  "towbar_api_keys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    configId: text("config_id").notNull(),
    name: text("name"),
    start: text("start"),
    referenceId: uuid("reference_id").notNull(),
    prefix: text("prefix"),
    key: text("key").notNull(),
    refillInterval: integer("refill_interval"),
    refillAmount: integer("refill_amount"),
    lastRefillAt: timestamp("last_refill_at", { withTimezone: true }),
    enabled: boolean("enabled").default(true),
    rateLimitEnabled: boolean("rate_limit_enabled").default(true),
    rateLimitTimeWindow: integer("rate_limit_time_window").default(60000),
    rateLimitMax: integer("rate_limit_max").default(60),
    requestCount: integer("request_count").default(0),
    remaining: integer("remaining"),
    lastRequest: timestamp("last_request", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    permissions: text("permissions"),
    metadata: text("metadata"),
  },
  (table) => [
    uniqueIndex("uq_towbar_api_key_hash").on(table.key),
    index("idx_towbar_api_keys_reference").on(table.referenceId),
    check(
      "towbar_api_keys_config",
      sql`${table.configId} in ('personal', 'team')`,
    ),
  ],
);

export const apiKeyPolicies = pgTable(
  "towbar_api_key_policies",
  {
    keyId: uuid("key_id")
      .primaryKey()
      .references(() => apiKeys.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    scope: text("scope").$type<"personal" | "team">().notNull(),
    ownerUserId: uuid("owner_user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    creatorUserId: uuid("creator_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    access: text("access").$type<"read" | "edit">().notNull(),
    includeAdmin: boolean("include_admin").default(false).notNull(),
    permissionMode: text("permission_mode")
      .$type<"scoped" | "full-admin">()
      .default("scoped")
      .notNull(),
    grants: jsonb("grants").$type<string[]>().notNull(),
    tokenType: text("token_type")
      .$type<"api-key" | "mcp-oauth">()
      .default("api-key")
      .notNull(),
    oauthClientId: text("oauth_client_id"),
    oauthClientName: text("oauth_client_name"),
    oauthClientLogo: text("oauth_client_logo"),
    oauthClientTrust: text("oauth_client_trust").$type<
      "metadata-document" | "unverified"
    >(),
    oauthResource: text("oauth_resource"),
    creationRequestId: uuid("creation_request_id").defaultRandom().notNull(),
    creationDigest: text("creation_digest").notNull(),
    version: integer("version").default(1).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("uq_towbar_api_policy_creation").on(
      table.workspaceId,
      table.creatorUserId,
      table.creationRequestId,
    ),
    index("idx_towbar_api_policy_workspace").on(table.workspaceId),
    check(
      "towbar_api_policy_token_type",
      sql`${table.tokenType} in ('api-key', 'mcp-oauth')`,
    ),
    check(
      "towbar_api_policy_permission_mode",
      sql`${table.permissionMode} = 'scoped' or (${table.permissionMode} = 'full-admin' and ${table.tokenType} = 'api-key' and ${table.access} = 'edit' and ${table.includeAdmin})`,
    ),
    check(
      "towbar_api_policy_oauth",
      sql`${table.tokenType} = 'api-key' or (${table.scope} = 'personal' and (not ${table.includeAdmin} or ${table.access} = 'edit') and ${table.oauthClientId} is not null and ${table.oauthResource} is not null and ${table.oauthClientTrust} in ('metadata-document', 'unverified'))`,
    ),
    check(
      "towbar_api_policy_scope",
      sql`(${table.scope} = 'personal' and ${table.ownerUserId} is not null) or (${table.scope} = 'team' and ${table.ownerUserId} is null)`,
    ),
    check("towbar_api_policy_access", sql`${table.access} in ('read', 'edit')`),
    check(
      "towbar_api_policy_admin",
      sql`not ${table.includeAdmin} or ${table.access} = 'edit'`,
    ),
  ],
);

export const transactionalEmails = pgTable(
  "towbar_transactional_emails",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    recipient: varchar("recipient", { length: 320 }).notNull(),
    template: varchar("template", { length: 80 }).notNull(),
    templateVersion: integer("template_version").default(1).notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    invitationId: uuid("invitation_id").references(
      () => workspaceInvitations.id,
    ),
    encryptedData: jsonb("encrypted_data").$type<EncryptedCredential>(),
    status: text("status")
      .$type<"pending" | "sending" | "sent" | "failed" | "canceled">()
      .default("pending")
      .notNull(),
    attempts: integer("attempts").default(0).notNull(),
    leaseToken: uuid("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("uq_towbar_transactional_email_dedupe").on(table.dedupeKey),
    index("idx_towbar_transactional_email_ready").on(
      table.status,
      table.nextAttemptAt,
    ),
  ],
);

export const workspacePrivateKeys = pgTable(
  "towbar_workspace_private_keys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 120 }).notNull(),
    description: varchar("description", { length: 500 }),
    algorithm: varchar("algorithm", { length: 24 })
      .$type<"ed25519" | "rsa" | "other">()
      .notNull(),
    generated: boolean("generated").default(false).notNull(),
    publicKey: text("public_key"),
    encryptedPrivateKey: jsonb("encrypted_private_key")
      .$type<EncryptedCredential>()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("uq_towbar_workspace_private_keys_name").on(
      table.workspaceId,
      table.name,
    ),
    index("idx_towbar_workspace_private_keys_workspace").on(table.workspaceId),
  ],
);

export const integrationInstallations = pgTable(
  "towbar_integration_installations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    provider: varchar("provider", { length: 64 })
      .$type<IntegrationProvider>()
      .notNull(),
    externalId: varchar("external_id", { length: 128 }).notNull(),
    principalId: varchar("principal_id", { length: 128 }),
    principalName: varchar("principal_name", { length: 255 }).notNull(),
    principalType: varchar("principal_type", { length: 40 }).notNull(),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("uq_towbar_integration_installation_external").on(
      table.provider,
      table.externalId,
    ),
    uniqueIndex("uq_towbar_integration_installation_workspace")
      .on(table.workspaceId, table.provider)
      .where(sql`${table.provider} <> 'github'`),
    uniqueIndex("uq_towbar_integration_installation_account").on(
      table.workspaceId,
      table.provider,
      table.principalId,
    ),
  ],
);

export const sources = pgTable(
  "towbar_sources",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    integrationInstallationId: uuid("integration_installation_id").references(
      () => integrationInstallations.id,
      { onDelete: "restrict" },
    ),
    integrationAuthorizationId: uuid("integration_authorization_id").references(
      () => integrationAuthorizations.id,
      { onDelete: "restrict" },
    ),
    provider: varchar("provider", { length: 16 })
      .$type<"github" | "gitlab">()
      .default("github")
      .notNull(),
    providerRepositoryId: varchar("provider_repository_id", { length: 128 }),
    repositoryOwner: varchar("repository_owner", { length: 255 }).notNull(),
    repositoryName: varchar("repository_name", { length: 255 }).notNull(),
    status: sourceStatusEnum("status").default("active").notNull(),
    autoDeployPaused: boolean("auto_deploy_paused").default(false).notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("uq_towbar_sources_secret_owner").on(table.id, table.workspaceId),
    uniqueIndex("uq_towbar_sources_repository").on(
      table.workspaceId,
      table.provider,
      table.repositoryOwner,
      table.repositoryName,
    ),
    check(
      "towbar_source_provider_connection",
      sql`(${table.provider} = 'github' AND ${table.integrationInstallationId} IS NOT NULL AND ${table.integrationAuthorizationId} IS NULL) OR (${table.provider} = 'gitlab' AND ${table.integrationInstallationId} IS NULL AND ${table.integrationAuthorizationId} IS NOT NULL AND ${table.providerRepositoryId} IS NOT NULL)`,
    ),
    index("idx_towbar_sources_workspace").on(table.workspaceId),
  ],
);

export const sourceEnvironments = pgTable(
  "towbar_source_environments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 63 }).notNull(),
    branch: varchar("branch", { length: 255 }).notNull(),
    mappingRevision: uuid("mapping_revision").defaultRandom().notNull(),
    previewsEnabled: boolean("previews_enabled").default(false).notNull(),
    latestCommitSha: varchar("latest_commit_sha", { length: 64 }),
    latestManifestDigest: varchar("latest_manifest_digest", { length: 64 }),
    latestSuccessfulSyncId: uuid("latest_successful_sync_id"),
    autoDeployPaused: boolean("auto_deploy_paused").default(false).notNull(),
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("uq_towbar_source_environments_name").on(
      table.sourceId,
      table.name,
    ),
    unique("uq_towbar_source_environments_owner").on(table.id, table.sourceId),
    index("idx_towbar_source_environments_branch").on(
      table.sourceId,
      table.branch,
    ),
  ],
);

export const sourceEntities = pgTable(
  "towbar_source_entities",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    entityType: varchar("entity_type", { length: 16 })
      .$type<"app" | "compose" | "resource">()
      .notNull(),
    manifestId: varchar("manifest_id", { length: 63 }).notNull(),
    resourceType: varchar("resource_type", { length: 16 }).$type<
      | "postgres"
      | "mysql"
      | "mariadb"
      | "mongodb"
      | "redis"
      | "dragonfly"
      | "keydb"
      | "clickhouse"
    >(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("uq_towbar_source_entities_identity").on(
      table.sourceId,
      table.entityType,
      table.manifestId,
    ),
    unique("uq_towbar_source_entities_owner").on(table.id, table.sourceId),
    check(
      "towbar_source_entity_kind",
      sql`(${table.entityType} IN ('app','compose') AND ${table.resourceType} IS NULL) OR (${table.entityType} = 'resource' AND ${table.resourceType} IN ('postgres','mysql','mariadb','mongodb','redis','dragonfly','keydb','clickhouse'))`,
    ),
  ],
);

export const integrationAuthorizations = pgTable(
  "towbar_integration_authorizations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    slug: varchar("slug", { length: 64 }).notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    description: varchar("description", { length: 500 }).default("").notNull(),
    provider: varchar("provider", { length: 64 })
      .$type<IntegrationProvider>()
      .notNull(),
    scopes: jsonb("scopes").$type<IntegrationScope[]>().default([]).notNull(),
    revision: integer("revision").default(1).notNull(),
    encryptedPayload: jsonb("encrypted_payload").$type<EncryptedCredential>(),
    credentialHint: varchar("credential_hint", { length: 8 }),
    verificationStatus: credentialVerificationStatusEnum("verification_status")
      .default("unverified")
      .notNull(),
    verificationMessage: varchar("verification_message", { length: 500 }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("uq_towbar_integration_workspace_slug").on(
      table.workspaceId,
      table.slug,
    ),
    uniqueIndex("uq_towbar_integration_workspace_provider").on(
      table.workspaceId,
      table.provider,
    ),
    index("idx_towbar_integration_workspace_id").on(
      table.workspaceId,
      table.id,
    ),
    check("towbar_integration_revision_positive", sql`${table.revision} > 0`),
    check(
      "towbar_integration_connection_state",
      sql`(${table.disconnectedAt} IS NULL AND ${table.encryptedPayload} IS NOT NULL) OR (${table.disconnectedAt} IS NOT NULL AND ${table.encryptedPayload} IS NULL)`,
    ),
    check(
      "towbar_integration_slug",
      sql`${table.slug} ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'`,
    ),
  ],
);

export const integrationAuthorizationAttempts = pgTable(
  "towbar_integration_authorization_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    requestedBy: uuid("requested_by").references(() => users.id, {
      onDelete: "cascade",
    }),
    provider: varchar("provider", { length: 64 })
      .$type<IntegrationProvider>()
      .notNull(),
    stateDigest: varchar("state_digest", { length: 64 }).notNull(),
    encryptedPayload: jsonb("encrypted_payload")
      .$type<EncryptedCredential>()
      .notNull(),
    redirectUri: varchar("redirect_uri", { length: 2048 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("uq_towbar_integration_authorization_state").on(
      table.provider,
      table.stateDigest,
    ),
    index("idx_towbar_integration_authorization_expiry").on(table.expiresAt),
  ],
);

export const notificationEvents = pgTable(
  "towbar_notification_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id").references(() => sources.id, {
      onDelete: "cascade",
    }),
    serverId: uuid("server_id").references(() => servers.id, {
      onDelete: "cascade",
    }),
    dedupeKey: varchar("dedupe_key", { length: 512 }).notNull(),
    type: varchar("type", { length: 80 })
      .$type<NotificationEventType>()
      .notNull(),
    category: varchar("category", { length: 40 })
      .$type<NotificationCategory | "test">()
      .notNull(),
    payload: jsonb("payload").$type<NotificationEventPayload>().notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_towbar_notification_events_workspace_occurred").on(
      table.workspaceId,
      table.occurredAt.desc(),
      table.id.desc(),
    ),
    index("idx_towbar_notification_events_workspace_id").on(
      table.workspaceId,
      table.id,
    ),
    check(
      "notificationEvents_scope",
      sql`num_nonnulls(${table.sourceId}, ${table.serverId}) = 1`,
    ),
    index("notificationEvents_server").on(table.serverId),
    uniqueIndex("uq_towbar_notification_events_server_dedupe").on(
      table.serverId,
      table.dedupeKey,
    ),
    uniqueIndex("uq_towbar_notification_events_dedupe").on(
      table.sourceId,
      table.dedupeKey,
    ),
    index("idx_towbar_notification_events_source_created").on(
      table.sourceId,
      table.createdAt,
    ),
  ],
);

export const notificationReads = pgTable(
  "towbar_notification_reads",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    eventId: uuid("event_id")
      .notNull()
      .references(() => notificationEvents.id, { onDelete: "cascade" }),
    readAt: timestamp("read_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.userId, table.eventId] }),
  ],
);

export const notificationDeliveries = pgTable(
  "towbar_notification_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => notificationEvents.id, { onDelete: "cascade" }),
    destinationKey: varchar("destination_key", { length: 64 }).notNull(),
    provider: notificationProviderEnum("provider").notNull(),
    state: notificationDeliveryStateEnum("state").default("pending").notNull(),
    cycle: integer("cycle").default(1).notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    lastErrorCode: varchar("last_error_code", { length: 100 }),
    lastErrorMessage: varchar("last_error_message", { length: 1_000 }),
    lastAttemptedAt: timestamp("last_attempted_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_towbar_notification_deliveries_cursor").on(
      table.createdAt,
      table.id,
    ),
    uniqueIndex("uq_towbar_notification_deliveries_event_destination").on(
      table.eventId,
      table.destinationKey,
    ),
    index("idx_towbar_notification_deliveries_state_next").on(
      table.state,
      table.nextAttemptAt,
    ),
    index("idx_towbar_notification_deliveries_destination_created").on(
      table.destinationKey,
      table.createdAt,
    ),
  ],
);

export const notificationEmailRouting = pgTable(
  "towbar_notification_email_routing",
  {
    workspaceId: uuid("workspace_id")
      .primaryKey()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    migratedAt: timestamp("migrated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
);

export const notificationEmailDestinations = pgTable(
  "towbar_notification_email_destinations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    email: varchar("email", { length: 320 }).notNull(),
    deployments: boolean("deployments").default(false).notNull(),
    deploymentFailures: boolean("deployment_failures").default(false).notNull(),
    health: boolean("health").default(false).notNull(),
    backupsAndRestores: boolean("backups_and_restores")
      .default(false)
      .notNull(),
    scout: boolean("scout").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("uq_towbar_notification_email_destination").on(
      table.workspaceId,
      table.email,
    ),
  ],
);

export const notificationSlackRouting = pgTable(
  "towbar_notification_slack_routing",
  {
    workspaceId: uuid("workspace_id")
      .primaryKey()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    migratedAt: timestamp("migrated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
);

export const notificationSlackDestinations = pgTable(
  "towbar_notification_slack_destinations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    channelId: varchar("channel_id", { length: 80 }).notNull(),
    legacyRouteIds: jsonb("legacy_route_ids")
      .$type<string[]>()
      .default([])
      .notNull(),
    deployments: boolean("deployments").default(false).notNull(),
    deploymentFailures: boolean("deployment_failures").default(false).notNull(),
    health: boolean("health").default(false).notNull(),
    backupsAndRestores: boolean("backups_and_restores")
      .default(false)
      .notNull(),
    scout: boolean("scout").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("uq_towbar_notification_slack_destination").on(
      table.workspaceId,
      table.channelId,
    ),
  ],
);

export const notificationDiscordRouteSettings = pgTable(
  "towbar_notification_discord_route_settings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    routeId: varchar("route_id", { length: 255 }).notNull(),
    deployments: boolean("deployments").default(false).notNull(),
    deploymentFailures: boolean("deployment_failures").default(false).notNull(),
    backupsAndRestores: boolean("backups_and_restores")
      .default(false)
      .notNull(),
    alertsAndIncidents: boolean("alerts_and_incidents")
      .default(false)
      .notNull(),
  },
  (table) => [
    uniqueIndex("uq_towbar_notification_discord_route_setting").on(
      table.workspaceId,
      table.routeId,
    ),
  ],
);

export const notificationWebhookRouteSettings = pgTable(
  "towbar_notification_webhook_route_settings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    routeId: varchar("route_id", { length: 255 }).notNull(),
    deployments: boolean("deployments").default(false).notNull(),
    deploymentFailures: boolean("deployment_failures").default(false).notNull(),
    backupsAndRestores: boolean("backups_and_restores")
      .default(false)
      .notNull(),
    alertsAndIncidents: boolean("alerts_and_incidents")
      .default(false)
      .notNull(),
  },
  (table) => [
    uniqueIndex("uq_towbar_notification_webhook_route_setting").on(
      table.workspaceId,
      table.routeId,
    ),
  ],
);

export const notificationTelegramRouting = pgTable(
  "towbar_notification_telegram_routing",
  {
    workspaceId: uuid("workspace_id")
      .primaryKey()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    migratedAt: timestamp("migrated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
);

export const notificationTelegramDestinations = pgTable(
  "towbar_notification_telegram_destinations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    chatId: varchar("chat_id", { length: 21 }).notNull(),
    // Zero represents the main chat so the unique index also covers destinations without a topic.
    messageThreadId: integer("message_thread_id").default(0).notNull(),
    legacyRouteIds: jsonb("legacy_route_ids")
      .$type<string[]>()
      .default([])
      .notNull(),
    deployments: boolean("deployments").default(false).notNull(),
    deploymentFailures: boolean("deployment_failures").default(false).notNull(),
    backupsAndRestores: boolean("backups_and_restores")
      .default(false)
      .notNull(),
    alertsAndIncidents: boolean("alerts_and_incidents")
      .default(false)
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("uq_towbar_notification_telegram_destination").on(
      table.workspaceId,
      table.chatId,
      table.messageThreadId,
    ),
  ],
);

export const notificationDeliveryAttempts = pgTable(
  "towbar_notification_delivery_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    deliveryId: uuid("delivery_id")
      .notNull()
      .references(() => notificationDeliveries.id, { onDelete: "cascade" }),
    cycle: integer("cycle").notNull(),
    sequence: integer("sequence").notNull(),
    state: notificationAttemptStateEnum("state").default("running").notNull(),
    providerStatus: varchar("provider_status", { length: 100 }),
    errorCode: varchar("error_code", { length: 100 }),
    errorMessage: varchar("error_message", { length: 1_000 }),
    startedAt: timestamp("started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("uq_towbar_notification_attempts_identity").on(
      table.deliveryId,
      table.cycle,
      table.sequence,
    ),
    index("idx_towbar_notification_attempts_delivery").on(table.deliveryId),
  ],
);

export const notificationThreads = pgTable(
  "towbar_notification_threads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    destinationKey: varchar("destination_key", { length: 64 }).notNull(),
    entityKind: varchar("entity_kind", { length: 40 }).notNull(),
    entityId: varchar("entity_id", { length: 255 }).notNull(),
    creatingDeliveryId: uuid("creating_delivery_id").references(
      () => notificationDeliveries.id,
      { onDelete: "set null" },
    ),
    providerThreadId: varchar("provider_thread_id", { length: 100 }),
    providerMessageId: varchar("provider_message_id", { length: 100 }),
    latestEventAt: timestamp("latest_event_at", {
      withTimezone: true,
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("uq_towbar_notification_threads_destination_entity").on(
      table.destinationKey,
      table.entityKind,
      table.entityId,
    ),
    index("idx_towbar_notification_threads_destination").on(
      table.destinationKey,
    ),
  ],
);

export const sourceSyncs = pgTable(
  "towbar_source_syncs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    sourceEnvironmentId: uuid("source_environment_id").references(
      () => sourceEnvironments.id,
      { onDelete: "cascade" },
    ),
    mappingRevision: uuid("mapping_revision"),
    deployAfterSync: boolean("deploy_after_sync").default(false).notNull(),
    status: sourceSyncStatusEnum("status").default("queued").notNull(),
    commitSha: varchar("commit_sha", { length: 64 }),
    manifestDigest: varchar("manifest_digest", { length: 64 }),
    rawManifest: text("raw_manifest"),
    normalizedManifest: jsonb(
      "normalized_manifest",
    ).$type<NormalizedDeploymentManifest>(),
    reconciliation: jsonb("reconciliation").$type<ManifestReconciliation>(),
    issues: jsonb("issues").$type<ManifestIssue[]>(),
    requestedByKeyId: uuid("requested_by_key_id").references(() => apiKeys.id, {
      onDelete: "set null",
    }),
    requestedByActor: jsonb("requested_by_actor").$type<{
      kind: "session" | "personal-key" | "team-key" | "system";
      workspaceId: string;
      userId?: string;
      keyId?: string;
      source?: "github" | "gitlab" | "worker";
      grants?: string[];
    }>(),
    requestedBy: uuid("requested_by").references(() => users.id, {
      onDelete: "set null",
    }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: "fk_towbar_source_syncs_environment_owner",
      columns: [table.sourceEnvironmentId, table.sourceId],
      foreignColumns: [sourceEnvironments.id, sourceEnvironments.sourceId],
    }).onDelete("cascade"),
    index("idx_towbar_source_syncs_source_created").on(
      table.sourceId,
      table.createdAt,
    ),
  ],
);

export const integrationWebhookDeliveries = pgTable(
  "towbar_integration_webhook_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    provider: varchar("provider", { length: 64 })
      .$type<IntegrationProvider>()
      .notNull(),
    authorizationId: uuid("authorization_id").references(
      () => integrationAuthorizations.id,
      { onDelete: "cascade" },
    ),
    installationId: uuid("installation_id").references(
      () => integrationInstallations.id,
      { onDelete: "cascade" },
    ),
    deliveryId: varchar("delivery_id", { length: 128 }).notNull(),
    eventName: varchar("event_name", { length: 100 }).notNull(),
    action: varchar("action", { length: 100 }),
    payloadDigest: varchar("payload_digest", { length: 64 }).notNull(),
    sourceId: uuid("source_id").references(() => sources.id, {
      onDelete: "set null",
    }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("uq_towbar_integration_webhook_delivery").on(
      table.provider,
      table.deliveryId,
    ),
    uniqueIndex("uq_towbar_integration_webhook_payload").on(
      table.provider,
      table.authorizationId,
      table.installationId,
      table.eventName,
      table.payloadDigest,
    ),
    index("idx_towbar_integration_webhook_source_occurred").on(
      table.sourceId,
      table.occurredAt,
    ),
    index("idx_towbar_integration_webhook_accepted").on(table.acceptedAt),
    check(
      "towbar_integration_webhook_identity",
      sql`num_nonnulls(${table.authorizationId}, ${table.installationId}) = 1`,
    ),
  ],
);

export const repositoryWebhookCursors = pgTable(
  "towbar_repository_webhook_cursors",
  {
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    eventKey: varchar("event_key", { length: 512 }).notNull(),
    deliveryId: varchar("delivery_id", { length: 128 }).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [primaryKey({ columns: [table.sourceId, table.eventKey] })],
);

export const servers = pgTable(
  "towbar_servers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    privateKeyId: uuid("private_key_id").references(
      () => workspacePrivateKeys.id,
      { onDelete: "restrict" },
    ),
    canonicalIp: varchar("canonical_ip", { length: 64 }).notNull(),
    name: varchar("name", { length: 120 }),
    config: jsonb("config").$type<NormalizedServer>().notNull(),
    configDigest: varchar("config_digest", { length: 64 }).notNull(),
    lastRemovedAt: timestamp("last_removed_at", { withTimezone: true }),
    preparedAt: timestamp("prepared_at", { withTimezone: true }),
    preparedConfigDigest: varchar("prepared_config_digest", { length: 64 }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("uq_towbar_servers_secret_owner").on(table.id, table.workspaceId),
    uniqueIndex("uq_towbar_servers_workspace_ip").on(
      table.workspaceId,
      table.canonicalIp,
    ),
    index("idx_towbar_servers_workspace").on(table.workspaceId),
    index("idx_towbar_servers_private_key").on(table.privateKeyId),
    index("idx_towbar_servers_archived_at").on(table.archivedAt),
  ],
);

// Ownership survives source/deployable deletion so cleanup stays server-scoped.
export const serverDeployableOwnership = pgTable(
  "towbar_server_deployable_ownership",
  {
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    deployableId: uuid("deployable_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.serverId, table.deployableId] })],
);

export const serverChecks = pgTable(
  "towbar_server_checks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    status: checkStatusEnum("status").default("queued").notNull(),
    result: jsonb("result").$type<Record<string, unknown>>(),
    errorCode: varchar("error_code", { length: 100 }),
    errorMessage: varchar("error_message", { length: 1_000 }),
    requestedByKeyId: uuid("requested_by_key_id").references(() => apiKeys.id, {
      onDelete: "set null",
    }),
    requestedByActor: jsonb("requested_by_actor").$type<{
      kind: "session" | "personal-key" | "team-key" | "system";
      workspaceId: string;
      userId?: string;
      keyId?: string;
      source?: "github" | "gitlab" | "worker";
      grants?: string[];
    }>(),
    requestedBy: uuid("requested_by").references(() => users.id, {
      onDelete: "set null",
    }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_towbar_server_checks_server").on(
      table.serverId,
      table.createdAt,
      table.id,
    ),
  ],
);

export const serverCredentialVerifications = pgTable(
  "towbar_server_credential_verifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    privateKeyId: uuid("private_key_id").references(
      () => workspacePrivateKeys.id,
      { onDelete: "set null" },
    ),
    status: checkStatusEnum("status").default("queued").notNull(),
    encryptedPrivateKey: jsonb(
      "encrypted_private_key",
    ).$type<EncryptedCredential>(),
    expectedCredentialRevision: uuid("expected_credential_revision"),
    result: jsonb("result").$type<Record<string, unknown>>(),
    errorCode: varchar("error_code", { length: 100 }),
    errorMessage: varchar("error_message", { length: 1_000 }),
    requestedByKeyId: uuid("requested_by_key_id").references(() => apiKeys.id, {
      onDelete: "set null",
    }),
    requestedByActor: jsonb("requested_by_actor").$type<{
      kind: "session" | "personal-key" | "team-key" | "system";
      workspaceId: string;
      userId?: string;
      keyId?: string;
      source?: "github" | "gitlab" | "worker";
      grants?: string[];
    }>(),
    requestedBy: uuid("requested_by").references(() => users.id, {
      onDelete: "set null",
    }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_towbar_server_credential_verifications_server").on(
      table.serverId,
      table.createdAt,
      table.id,
    ),
    uniqueIndex("uq_towbar_server_credential_verifications_active")
      .on(table.serverId)
      .where(sql`${table.status} in ('queued', 'running')`),
  ],
);

export const serverPreparations = pgTable(
  "towbar_server_preparations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    configDigest: varchar("config_digest", { length: 64 }).notNull(),
    status: checkStatusEnum("status").default("queued").notNull(),
    steps: jsonb("steps").$type<ServerPreparationStep[]>().notNull(),
    result: jsonb("result").$type<Record<string, unknown>>(),
    errorCode: varchar("error_code", { length: 100 }),
    errorMessage: varchar("error_message", { length: 1_000 }),
    requestedByKeyId: uuid("requested_by_key_id").references(() => apiKeys.id, {
      onDelete: "set null",
    }),
    requestedByActor: jsonb("requested_by_actor").$type<{
      kind: "session" | "personal-key" | "team-key" | "system";
      workspaceId: string;
      userId?: string;
      keyId?: string;
      source?: "github" | "gitlab" | "worker";
      grants?: string[];
    }>(),
    requestedBy: uuid("requested_by").references(() => users.id, {
      onDelete: "set null",
    }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_towbar_server_preparations_server_created").on(
      table.serverId,
      table.createdAt,
    ),
    uniqueIndex("uq_towbar_server_preparations_active")
      .on(table.serverId)
      .where(sql`${table.status} in ('queued', 'running')`),
  ],
);

export const sshHostKeys = pgTable(
  "towbar_ssh_host_keys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    algorithm: varchar("algorithm", { length: 80 }).notNull(),
    fingerprint: varchar("fingerprint", { length: 255 }).notNull(),
    publicKey: text("public_key").notNull(),
    trustedBy: uuid("trusted_by").references(() => users.id, {
      onDelete: "restrict",
    }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("uq_towbar_ssh_host_keys_active").on(
      table.serverId,
      table.fingerprint,
    ),
  ],
);

export const apps = pgTable(
  "towbar_apps",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "restrict" }),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => sourceEntities.id, {
        onDelete: "cascade",
      }),
    sourceEnvironmentId: uuid("source_environment_id")
      .notNull()
      .references(() => sourceEnvironments.id, { onDelete: "cascade" }),
    requiredSecrets: jsonb("required_secrets")
      .$type<RequiredSecrets>()
      .notNull(),
    manifestId: varchar("manifest_id", { length: 63 }).notNull(),
    kind: deployableKindEnum("kind").default("app").notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    description: varchar("description", { length: 500 }),
    config: jsonb("config").$type<NormalizedDeployable>().notNull(),
    configDigest: varchar("config_digest", { length: 64 }).notNull(),
    deploymentDigest: varchar("deployment_digest", { length: 64 }),
    sourceInputDigest: varchar("source_input_digest", { length: 64 }),
    sourceRevision: varchar("source_revision", { length: 64 }).notNull(),
    autoDeployPaused: boolean("auto_deploy_paused").default(false).notNull(),
    deferredAutomaticDeployment: jsonb(
      "deferred_automatic_deployment",
    ).$type<DeferredAutomaticDeployment>(),
    manifestState: varchar("manifest_state", { length: 16 })
      .$type<"active" | "conflict" | "retired" | "removing" | "removed">()
      .default("active")
      .notNull(),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    legacyArchivedAt: timestamp("legacy_archived_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: "fk_towbar_apps_environment_owner",
      columns: [table.sourceEnvironmentId, table.sourceId],
      foreignColumns: [sourceEnvironments.id, sourceEnvironments.sourceId],
    }).onDelete("cascade"),
    foreignKey({
      name: "fk_towbar_apps_entity_owner",
      columns: [table.entityId, table.sourceId],
      foreignColumns: [sourceEntities.id, sourceEntities.sourceId],
    }).onDelete("cascade"),
    foreignKey({
      name: "fk_towbar_apps_source_owner",
      columns: [table.sourceId, table.workspaceId],
      foreignColumns: [sources.id, sources.workspaceId],
    }).onDelete("cascade"),
    foreignKey({
      name: "fk_towbar_apps_server_owner",
      columns: [table.serverId, table.workspaceId],
      foreignColumns: [servers.id, servers.workspaceId],
    }).onDelete("restrict"),
    unique("uq_towbar_apps_secret_owner").on(
      table.id,
      table.workspaceId,
      table.sourceId,
    ),
    uniqueIndex("uq_towbar_apps_environment_entity")
      .on(table.sourceEnvironmentId, table.entityId)
      .where(sql`${table.manifestState} <> 'removed'`),
    check(
      "towbar_apps_manifest_state",
      sql`${table.manifestState} IN ('active','conflict','retired','removing','removed')`,
    ),
    index("idx_towbar_apps_workspace").on(table.workspaceId),
    index("idx_towbar_apps_server").on(table.serverId),
    index("idx_towbar_apps_archived_at").on(table.archivedAt),
  ],
);

export const previewEnvironments = pgTable(
  "towbar_preview_environments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "restrict" }),
    pullRequestNumber: integer("pull_request_number").notNull(),
    branch: varchar("branch", { length: 255 }).notNull(),
    gitRef: varchar("git_ref", { length: 512 }).notNull(),
    hostname: varchar("hostname", { length: 253 }).notNull(),
    runtimeId: varchar("runtime_id", { length: 255 }).notNull(),
    latestCommitSha: varchar("latest_commit_sha", { length: 64 }).notNull(),
    latestDeploymentId: uuid("latest_deployment_id"),
    status: previewEnvironmentStatusEnum("status")
      .default("building")
      .notNull(),
    errorMessage: varchar("error_message", { length: 1_000 }),
    cleanupRequestedByActor: jsonb("cleanup_requested_by_actor").$type<{
      kind: "session" | "personal-key" | "team-key" | "system";
      workspaceId: string;
      userId?: string;
      keyId?: string;
      source?: "github" | "gitlab" | "worker";
      grants?: string[];
    }>(),
    cleanupStartedAt: timestamp("cleanup_started_at", { withTimezone: true }),
    cleanupAttempts: integer("cleanup_attempts").default(0).notNull(),
    lastCleanupAttemptAt: timestamp("last_cleanup_attempt_at", {
      withTimezone: true,
    }),
    nextCleanupAttemptAt: timestamp("next_cleanup_attempt_at", {
      withTimezone: true,
    }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("uq_towbar_preview_environment_ref").on(
      table.sourceId,
      table.appId,
      table.gitRef,
    ),
    uniqueIndex("uq_towbar_preview_environment_hostname").on(table.hostname),
    index("idx_towbar_preview_environment_source_status").on(
      table.sourceId,
      table.status,
    ),
    index("idx_towbar_preview_environment_expires").on(
      table.status,
      table.expiresAt,
    ),
  ],
);

export const previewPullRequestReports = pgTable(
  "towbar_preview_pull_request_reports",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    pullRequestNumber: integer("pull_request_number").notNull(),
    branch: varchar("branch", { length: 255 }).notNull(),
    latestCommitSha: varchar("latest_commit_sha", { length: 64 }).notNull(),
    skippedApps: jsonb("skipped_apps")
      .$type<
        Array<{
          appId: string;
          appName: string;
          reason: string;
          blocked?: boolean;
        }>
      >()
      .default([])
      .notNull(),
    commentDeliveryStatus: previewReportDeliveryStatusEnum(
      "comment_delivery_status",
    )
      .default("pending")
      .notNull(),
    commentDeliveryError: varchar("comment_delivery_error", { length: 1_000 }),
    commentLastAttemptedAt: timestamp("comment_last_attempted_at", {
      withTimezone: true,
    }),
    commentDeliveryAttempts: integer("comment_delivery_attempts")
      .default(0)
      .notNull(),
    commentNextAttemptAt: timestamp("comment_next_attempt_at", {
      withTimezone: true,
    }),
    commentPublishedAt: timestamp("comment_published_at", {
      withTimezone: true,
    }),
    deploymentDeliveryStatus: previewReportDeliveryStatusEnum(
      "deployment_delivery_status",
    )
      .default("pending")
      .notNull(),
    deploymentDeliveryError: varchar("deployment_delivery_error", {
      length: 1_000,
    }),
    deploymentLastAttemptedAt: timestamp("deployment_last_attempted_at", {
      withTimezone: true,
    }),
    deploymentDeliveryAttempts: integer("deployment_delivery_attempts")
      .default(0)
      .notNull(),
    deploymentNextAttemptAt: timestamp("deployment_next_attempt_at", {
      withTimezone: true,
    }),
    deploymentPublishedAt: timestamp("deployment_published_at", {
      withTimezone: true,
    }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_towbar_preview_report_comment_retry")
      .on(table.commentNextAttemptAt)
      .where(sql`${table.commentDeliveryStatus} in ('pending', 'failed')`),
    index("idx_towbar_preview_report_deployment_retry")
      .on(table.deploymentNextAttemptAt)
      .where(sql`${table.deploymentDeliveryStatus} in ('pending', 'failed')`),
    uniqueIndex("uq_towbar_preview_report_source_pr").on(
      table.sourceId,
      table.pullRequestNumber,
    ),
    index("idx_towbar_preview_report_workspace_comment").on(
      table.workspaceId,
      table.commentDeliveryStatus,
    ),
    index("idx_towbar_preview_report_workspace_deployment").on(
      table.workspaceId,
      table.deploymentDeliveryStatus,
    ),
  ],
);

export const deployments = pgTable(
  "towbar_deployments",
  {
    targetEnvironment: jsonb("target_environment")
      .$type<{
        id: string;
        name: string;
        branch: string;
        mappingRevision: string;
      }>()
      .notNull(),
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "restrict" }),
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "restrict" }),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "restrict" }),
    buildServerId: uuid("build_server_id").references(() => servers.id, {
      onDelete: "restrict",
    }),
    requestedByKeyId: uuid("requested_by_key_id").references(() => apiKeys.id, {
      onDelete: "set null",
    }),
    requestedByActor: jsonb("requested_by_actor").$type<{
      kind: "session" | "personal-key" | "team-key" | "system";
      workspaceId: string;
      userId?: string;
      keyId?: string;
      source?: "github" | "gitlab" | "worker";
      grants?: string[];
    }>(),
    requestedBy: uuid("requested_by").references(() => users.id, {
      onDelete: "restrict",
    }),
    idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull(),
    temporalWorkflowId: varchar("temporal_workflow_id", {
      length: 255,
    }).notNull(),
    kind: deploymentKindEnum("kind").default("deploy").notNull(),
    secretRevisions:
      jsonb("secret_revisions").$type<Record<string, string | null>>(),
    environment: deploymentEnvironmentEnum("environment")
      .default("production")
      .notNull(),
    gitRef: varchar("git_ref", { length: 512 }),
    hostname: varchar("hostname", { length: 253 }),
    githubDeploymentId: varchar("github_deployment_id", { length: 40 }),
    githubDeploymentStatus: varchar("github_deployment_status", { length: 40 }),
    previewEnvironmentId: uuid("preview_environment_id").references(
      () => previewEnvironments.id,
      { onDelete: "restrict" },
    ),
    deployableKind: deployableKindEnum("deployable_kind")
      .default("app")
      .notNull(),
    state: deploymentStateEnum("state").default("queued").notNull(),
    commitSha: varchar("commit_sha", { length: 64 }).notNull(),
    configDigest: varchar("config_digest", { length: 64 }),
    deploymentDigest: varchar("deployment_digest", { length: 64 }),
    sourceInputDigest: varchar("source_input_digest", { length: 64 }),
    manifestDigest: varchar("manifest_digest", { length: 64 }).notNull(),
    imageDigest: varchar("image_digest", { length: 71 }),
    imageSourceReference: varchar("image_source_reference", { length: 512 }),
    imagePlatform: varchar("image_platform", { length: 64 }),
    requiredSecrets: jsonb("required_secrets")
      .$type<RequiredSecrets>()
      .notNull(),
    domainHandoffSnapshot: jsonb("domain_handoff_snapshot")
      .$type<DomainHandoff[]>()
      .default([])
      .notNull(),
    appSnapshot: jsonb("app_snapshot").$type<NormalizedDeployable>().notNull(),
    serverSnapshot: jsonb("server_snapshot")
      .$type<NormalizedServer>()
      .notNull(),
    buildServerSnapshot: jsonb(
      "build_server_snapshot",
    ).$type<NormalizedServer>(),
    rollbackReleaseSnapshot: jsonb("rollback_release_snapshot").$type<{
      commitSha: string;
      containerName: string;
      imageTag: string;
      releaseId: string;
      sourceDeploymentId: string;
    }>(),
    errorCode: varchar("error_code", { length: 100 }),
    errorMessage: varchar("error_message", { length: 1_000 }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "chk_towbar_deployments_rollback_snapshot",
      sql`(${table.kind} = 'deploy' AND ${table.rollbackReleaseSnapshot} IS NULL) OR (${table.kind} = 'rollback' AND ${table.rollbackReleaseSnapshot} IS NOT NULL)`,
    ),
    check(
      "chk_towbar_deployments_environment",
      sql`(${table.environment} = 'production' AND ${table.previewEnvironmentId} IS NULL AND ${table.gitRef} IS NULL AND ${table.hostname} IS NULL) OR (${table.environment} = 'preview' AND ${table.previewEnvironmentId} IS NOT NULL AND ${table.gitRef} IS NOT NULL AND ${table.hostname} IS NOT NULL)`,
    ),
    check(
      "chk_towbar_deployments_build_server_snapshot",
      sql`(${table.buildServerId} IS NULL AND ${table.buildServerSnapshot} IS NULL) OR (${table.buildServerId} IS NOT NULL AND ${table.buildServerSnapshot} IS NOT NULL)`,
    ),
    uniqueIndex("uq_towbar_deployments_idempotency").on(
      table.workspaceId,
      table.idempotencyKey,
    ),
    uniqueIndex("uq_towbar_deployments_workflow_id").on(
      table.temporalWorkflowId,
    ),
    index("idx_towbar_deployments_app_created").on(
      table.appId,
      table.createdAt,
    ),
    index("idx_towbar_deployments_server_state").on(
      table.serverId,
      table.state,
    ),
    index("idx_towbar_deployments_build_server_state").on(
      table.buildServerId,
      table.state,
    ),
    index("idx_towbar_deployments_preview_created").on(
      table.previewEnvironmentId,
      table.createdAt,
    ),
  ],
);

export const deploymentSteps = pgTable(
  "towbar_deployment_steps",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    deploymentId: uuid("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    state: deploymentStateEnum("state").notNull(),
    status: deploymentStepStatusEnum("status").default("waiting").notNull(),
    message: varchar("message", { length: 1_000 }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("uq_towbar_deployment_steps_sequence").on(
      table.deploymentId,
      table.sequence,
    ),
  ],
);

export const deploymentLogChunks = pgTable(
  "towbar_deployment_log_chunks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    deploymentId: uuid("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    stream: varchar("stream", { length: 20 }).notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("uq_towbar_deployment_logs_sequence").on(
      table.deploymentId,
      table.sequence,
    ),
    index("idx_towbar_deployment_logs_created").on(table.createdAt),
  ],
);

export const imageVulnerabilityScans = pgTable(
  "towbar_image_vulnerability_scans",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "restrict" }),
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "restrict" }),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "restrict" }),
    deploymentId: uuid("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "restrict" }),
    imageDigest: varchar("image_digest", { length: 71 }).notNull(),
    state: vulnerabilityScanStateEnum("state").default("pending").notNull(),
    cycle: integer("cycle").default(1).notNull(),
    scannerName: varchar("scanner_name", { length: 100 }),
    scannerVersion: varchar("scanner_version", { length: 100 }),
    vulnerabilityDatabaseUpdatedAt: timestamp(
      "vulnerability_database_updated_at",
      { withTimezone: true },
    ),
    severityTotals: jsonb("severity_totals")
      .$type<VulnerabilitySeverityTotals>()
      .notNull(),
    findingsTruncated: boolean("findings_truncated").default(false).notNull(),
    errorCode: varchar("error_code", { length: 100 }),
    errorMessage: varchar("error_message", { length: 1_000 }),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("uq_towbar_vulnerability_scans_workspace_digest").on(
      table.workspaceId,
      table.imageDigest,
    ),
    index("idx_towbar_vulnerability_scans_state_requested").on(
      table.state,
      table.requestedAt,
    ),
    index("idx_towbar_vulnerability_scans_deployment").on(table.deploymentId),
  ],
);

export const imageVulnerabilityFindings = pgTable(
  "towbar_image_vulnerability_findings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    scanId: uuid("scan_id")
      .notNull()
      .references(() => imageVulnerabilityScans.id, { onDelete: "cascade" }),
    advisoryId: varchar("advisory_id", { length: 160 }).notNull(),
    severity: vulnerabilitySeverityEnum("severity").notNull(),
    packageName: varchar("package_name", { length: 255 }).notNull(),
    installedVersion: varchar("installed_version", { length: 255 }).notNull(),
    fixedVersion: varchar("fixed_version", { length: 255 }),
    target: varchar("target", { length: 512 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_towbar_vulnerability_findings_scan_severity").on(
      table.scanId,
      table.severity,
    ),
  ],
);

export const releases = pgTable(
  "towbar_releases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    deploymentId: uuid("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "restrict" }),
    environment: deploymentEnvironmentEnum("environment")
      .default("production")
      .notNull(),
    gitRef: varchar("git_ref", { length: 512 }),
    previewEnvironmentId: uuid("preview_environment_id").references(
      () => previewEnvironments.id,
      { onDelete: "restrict" },
    ),
    status: releaseStatusEnum("status").notNull(),
    commitSha: varchar("commit_sha", { length: 64 }).notNull(),
    configDigest: varchar("config_digest", { length: 64 }),
    deploymentDigest: varchar("deployment_digest", { length: 64 }),
    sourceInputDigest: varchar("source_input_digest", { length: 64 }),
    imageDigest: varchar("image_digest", { length: 71 }),
    imagePlatform: varchar("image_platform", { length: 64 }),
    imageTag: varchar("image_tag", { length: 512 }).notNull(),
    containerName: varchar("container_name", { length: 255 }).notNull(),
    containerNames: jsonb("container_names")
      .$type<string[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),
    composeServices: jsonb("compose_services")
      .$type<string[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),
    promotedAt: timestamp("promoted_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("uq_towbar_releases_deployment").on(table.deploymentId),
    index("idx_towbar_releases_app_status").on(table.appId, table.status),
    index("idx_towbar_releases_preview_status").on(
      table.previewEnvironmentId,
      table.status,
    ),
    check(
      "chk_towbar_releases_environment",
      sql`(${table.environment} = 'production' AND ${table.previewEnvironmentId} IS NULL AND ${table.gitRef} IS NULL) OR (${table.environment} = 'preview' AND ${table.previewEnvironmentId} IS NOT NULL AND ${table.gitRef} IS NOT NULL)`,
    ),
  ],
);

export const resourceOperations = pgTable(
  "towbar_resource_operations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id").references(() => sources.id, {
      onDelete: "cascade",
    }),
    resourceId: uuid("resource_id").references(() => apps.id, {
      onDelete: "cascade",
    }),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    requestedByKeyId: uuid("requested_by_key_id").references(() => apiKeys.id, {
      onDelete: "set null",
    }),
    requestedByActor: jsonb("requested_by_actor").$type<{
      kind: "session" | "personal-key" | "team-key" | "system";
      workspaceId: string;
      userId?: string;
      keyId?: string;
      source?: "github" | "gitlab" | "worker";
      grants?: string[];
    }>(),
    requestedBy: uuid("requested_by").references(() => users.id, {
      onDelete: "set null",
    }),
    idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull(),
    temporalWorkflowId: varchar("temporal_workflow_id", {
      length: 255,
    }).notNull(),
    type: resourceOperationTypeEnum("type").notNull(),
    state: resourceOperationStateEnum("state").default("queued").notNull(),
    phase: varchar("phase", { length: 64 }).$type<RestoreOperationPhase>(),
    request: jsonb("request")
      .$type<PersistedResourceOperationRequest>()
      .notNull(),
    result: jsonb("result").$type<ResourceOperationResult>(),
    appSnapshot: jsonb("app_snapshot").$type<NormalizedDeployable>(),
    serverSnapshot: jsonb("server_snapshot")
      .$type<NormalizedServer>()
      .notNull(),
    errorCode: varchar("error_code", { length: 100 }),
    errorMessage: varchar("error_message", { length: 1_000 }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("uq_towbar_resource_operations_idempotency").on(
      table.workspaceId,
      table.idempotencyKey,
    ),
    uniqueIndex("uq_towbar_resource_operations_workflow").on(
      table.temporalWorkflowId,
    ),
    index("idx_towbar_resource_operations_resource_created").on(
      table.resourceId,
      table.createdAt,
    ),
    index("idx_towbar_resource_operations_server_state").on(
      table.serverId,
      table.state,
    ),
    check(
      "chk_towbar_resource_operations_owner",
      sql`(${table.type} = 'cleanup_orphans' AND ${table.sourceId} IS NULL AND ${table.resourceId} IS NULL) OR (${table.type} <> 'cleanup_orphans' AND ${table.sourceId} IS NOT NULL AND ${table.resourceId} IS NOT NULL)`,
    ),
  ],
);

export const resourceOperationEvents = pgTable(
  "towbar_resource_operation_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    operationId: uuid("operation_id")
      .notNull()
      .references(() => resourceOperations.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    phase: varchar("phase", { length: 64 })
      .$type<RestoreOperationPhase>()
      .notNull(),
    level: varchar("level", { length: 16 })
      .$type<"error" | "info" | "success">()
      .default("info")
      .notNull(),
    message: varchar("message", { length: 1_000 }).notNull(),
    command: varchar("command", { length: 1_000 }),
    metadata: jsonb("metadata")
      .$type<Record<string, boolean | number | string | null>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("uq_towbar_resource_operation_events_sequence").on(
      table.operationId,
      table.sequence,
    ),
    index("idx_towbar_resource_operation_events_created").on(
      table.operationId,
      table.createdAt,
    ),
  ],
);

export const resourceBackupAssurances = pgTable(
  "towbar_resource_backup_assurances",
  {
    resourceId: uuid("resource_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    backupOperationId: uuid("backup_operation_id")
      .primaryKey()
      .references(() => resourceOperations.id, { onDelete: "cascade" }),
    status: backupAssuranceStatusEnum("status").notNull(),
    restoreReady: boolean("restore_ready").default(false).notNull(),
    checks: jsonb("checks")
      .$type<BackupAssuranceCheck[]>()
      .notNull()
      .default([]),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_towbar_backup_assurances_resource").on(table.resourceId),
    index("idx_towbar_backup_assurances_status").on(table.status),
  ],
);

export const deployableRuntimeStates = pgTable(
  "towbar_deployable_runtime_states",
  {
    appId: uuid("app_id")
      .primaryKey()
      .references(() => apps.id, { onDelete: "cascade" }),
    desiredState: runtimeDesiredStateEnum("desired_state")
      .default("running")
      .notNull(),
    observedState: runtimeObservedStateEnum("observed_state")
      .default("unknown")
      .notNull(),
    healthStatus: runtimeHealthStateEnum("health_status")
      .default("unknown")
      .notNull(),
    driftStatus: runtimeDriftStateEnum("drift_status")
      .default("unknown")
      .notNull(),
    driftReasons: jsonb("drift_reasons")
      .$type<string[]>()
      .notNull()
      .default([]),
    observedContainerName: varchar("observed_container_name", { length: 255 }),
    observedImage: varchar("observed_image", { length: 512 }),
    ingressStatus: varchar("ingress_status", { length: 32 })
      .$type<
        | "disabled"
        | "missing"
        | "ready"
        | "reconnecting"
        | "stopped"
        | "unknown"
      >()
      .default("unknown")
      .notNull(),
    ingressContainerName: varchar("ingress_container_name", { length: 255 }),
    ingressImage: varchar("ingress_image", { length: 512 }),
    ingressRestartCount: integer("ingress_restart_count"),
    lastCheckId: uuid("last_check_id").references(() => serverChecks.id, {
      onDelete: "set null",
    }),
    checkedAt: timestamp("checked_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("idx_towbar_runtime_drift").on(table.driftStatus)],
);

export const requestNonces = pgTable(
  "towbar_request_nonces",
  {
    scope: varchar("scope", { length: 160 }).notNull(),
    nonce: varchar("nonce", { length: 160 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.scope, table.nonce],
      name: "pk_towbar_request_nonces",
    }),
    index("idx_towbar_request_nonces_expires").on(table.expiresAt),
  ],
);

export const systemHealthSignals = pgTable(
  "towbar_system_health_signals",
  {
    key: varchar("key", { length: 255 }).primaryKey(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
      onDelete: "cascade",
    }),
    component: varchar("component", { length: 80 }).notNull(),
    status: varchar("status", { length: 32 }).notNull(),
    message: varchar("message", { length: 500 }).notNull(),
    version: varchar("version", { length: 64 }),
    details: jsonb("details")
      .$type<Record<string, boolean | number | string | null>>()
      .notNull()
      .default({}),
    checkedAt: timestamp("checked_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_towbar_system_health_workspace").on(
      table.workspaceId,
      table.component,
    ),
  ],
);

export const databaseStorageSamples = pgTable(
  "towbar_database_storage_samples",
  {
    sampledAt: timestamp("sampled_at", { withTimezone: true })
      .defaultNow()
      .primaryKey(),
    towbarBytes: bigint("towbar_bytes", { mode: "number" }).notNull(),
    monitoringBytes: bigint("monitoring_bytes", { mode: "number" }).notNull(),
    analyticsBytes: bigint("analytics_bytes", { mode: "number" }),
    logsBytes: bigint("logs_bytes", { mode: "number" }),
    logsError: text("logs_error"),
  },
);

// Secret configuration is independent of manifest snapshots. Foreign keys retain
// credentials on archive and remove them only when their owner is deleted.
export const managedSecrets = pgTable(
  "towbar_managed_secrets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id").references(() => sources.id, {
      onDelete: "cascade",
    }),
    appId: uuid("app_id").references(() => apps.id, { onDelete: "cascade" }),
    serverId: uuid("server_id").references(() => servers.id, {
      onDelete: "cascade",
    }),
    owner: text("owner").notNull(),
    environment: varchar("environment", { length: 80 })
      .notNull()
      .default("production"),
    stage: text("stage").notNull(),
    encryptedPayload: jsonb("encrypted_payload")
      .$type<EncryptedCredential>()
      .notNull(),
    keys: jsonb("keys").$type<string[]>().notNull(),
    revision: uuid("revision").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "fk_towbar_secret_sources_owner",
      columns: [table.sourceId, table.workspaceId],
      foreignColumns: [sources.id, sources.workspaceId],
    }).onDelete("cascade"),
    foreignKey({
      name: "fk_towbar_secret_apps_owner",
      columns: [table.appId, table.workspaceId, table.sourceId],
      foreignColumns: [apps.id, apps.workspaceId, apps.sourceId],
    })
      .onDelete("cascade")
      .onUpdate("cascade"),
    foreignKey({
      name: "fk_towbar_secret_servers_owner",
      columns: [table.serverId, table.workspaceId],
      foreignColumns: [servers.id, servers.workspaceId],
    }).onDelete("cascade"),
    uniqueIndex("uq_towbar_managed_secret_slot").on(
      table.workspaceId,
      table.owner,
      table.environment,
      table.stage,
    ),
    check(
      "towbar_managed_secret_owner",
      sql`(
    (${table.owner} = 'workspace:' || ${table.workspaceId}::text AND ${table.sourceId} IS NULL AND ${table.appId} IS NULL AND ${table.serverId} IS NULL)
    OR (${table.owner} = 'repository:' || ${table.sourceId}::text AND ${table.sourceId} IS NOT NULL AND ${table.appId} IS NULL AND ${table.serverId} IS NULL AND ${table.environment} = 'production')
    OR (${table.owner} = 'app:' || ${table.appId}::text AND ${table.appId} IS NOT NULL AND ${table.sourceId} IS NOT NULL AND ${table.serverId} IS NULL)
    OR (${table.owner} = 'server:' || ${table.serverId}::text AND ${table.serverId} IS NOT NULL AND ${table.sourceId} IS NULL AND ${table.appId} IS NULL)
  ) IS TRUE`,
    ),
    check(
      "towbar_managed_secret_stage",
      sql`(
    (${table.stage} IN ('build', 'deployment', 'pre_deploy', 'post_deploy') AND (${table.owner} = 'workspace:' || ${table.workspaceId}::text OR ${table.owner} = 'repository:' || ${table.sourceId}::text OR ${table.appId} IS NOT NULL))
    OR (${table.stage} = 'credentials' AND ${table.serverId} IS NOT NULL AND ${table.environment} = 'production')
  )`,
    ),
  ],
);

export const monitoringAgents = pgTable(
  "towbar_monitoring_agents",
  {
    serverId: uuid("server_id")
      .primaryKey()
      .references(() => servers.id, { onDelete: "cascade" }),
    retentionDays: integer("retention_days").notNull().default(15),
    desiredState: varchar("desired_state", { length: 20 })
      .notNull()
      .default("disabled"),
    status: varchar("status", { length: 20 }).notNull().default("disabled"),
    generation: uuid("generation").notNull().defaultRandom(),
    tokenHash: varchar("token_hash", { length: 64 }),
    encryptedToken: jsonb("encrypted_token").$type<EncryptedCredential>(),
    removalRequested: boolean("removal_requested").default(false).notNull(),
    removalRequestedBy: uuid("removal_requested_by").references(
      () => users.id,
      { onDelete: "set null" },
    ),
    installedVersion: varchar("installed_version", { length: 64 }),
    lastReportAt: timestamp("last_report_at", { withTimezone: true }),
    lastCollectedAt: timestamp("last_collected_at", { withTimezone: true }),
    diagnostics: jsonb("diagnostics").$type<{
      collectionDurationMs: number;
      collectionErrors: number;
      droppedSamples: number;
      analyticsDropped?: number;
      analyticsGeoBuiltAt?: string;
      analyticsListenerReady?: boolean;
    }>(),
    errorMessage: text("error_message"),
    operationStartedAt: timestamp("operation_started_at", {
      withTimezone: true,
    }),
    requestedByKeyId: uuid("requested_by_key_id").references(() => apiKeys.id, {
      onDelete: "set null",
    }),
    requestedByActor: jsonb("requested_by_actor").$type<{
      kind: "session" | "personal-key" | "team-key" | "system";
      workspaceId: string;
      userId?: string;
      keyId?: string;
      source?: "github" | "gitlab" | "worker";
      grants?: string[];
    }>(),
    requestedBy: uuid("requested_by").references(() => users.id, {
      onDelete: "set null",
    }),
    ingestWindow: timestamp("ingest_window", { withTimezone: true }),
    ingestCount: integer("ingest_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "towbar_monitoring_retention",
      sql`${table.retentionDays} in (7,15,30,60)`,
    ),
    check(
      "towbar_monitoring_desired_state",
      sql`${table.desiredState} in ('enabled','disabled')`,
    ),
    check(
      "towbar_monitoring_status",
      sql`${table.status} in ('disabled','queued','installing','waiting','online','uninstalling','failed')`,
    ),
  ],
);

export const serverObservations = pgTable("towbar_server_observations", {
  serverId: uuid("server_id")
    .primaryKey()
    .references(() => servers.id, { onDelete: "cascade" }),
  hardware:
    jsonb("hardware").$type<import("@workspace/towbar-core").ServerHardware>(),
  hardwareAt: timestamp("hardware_at", { withTimezone: true }),
  instanceAt: timestamp("instance_at", { withTimezone: true }),
  bootId: uuid("boot_id"),
  bootObservedAt: timestamp("boot_observed_at", { withTimezone: true }),
});

export const serverEvents = pgTable(
  "towbar_server_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    at: timestamp("at", { withTimezone: true }).notNull(),
    type: varchar("type", { length: 24 })
      .$type<"host-restart" | "instance-change" | "capacity-change">()
      .notNull(),
    detail: text("detail").notNull(),
  },
  (table) => [
    index("towbar_server_event_time").on(table.serverId, table.at),
    check(
      "towbar_server_event_type",
      sql`${table.type} in ('host-restart','instance-change','capacity-change')`,
    ),
  ],
);

export const monitoringBatches = pgTable(
  "towbar_monitoring_batches",
  {
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    sampleId: varchar("sample_id", { length: 32 }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.serverId, table.sampleId] }),
    index("towbar_monitoring_batch_age").on(table.receivedAt),
  ],
);

export const monitoringSamples = pgTable(
  "towbar_monitoring_samples",
  {
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    entityId: varchar("entity_id", { length: 64 }).notNull(),
    bucketAt: timestamp("bucket_at", { withTimezone: true }).notNull(),
    resolution: integer("resolution").notNull().default(30),
    deployableId: uuid("deployable_id"),
    deploymentId: uuid("deployment_id"),
    previewId: uuid("preview_id"),
    state: varchar("state", { length: 20 }),
    health: varchar("health", { length: 20 }),
    metrics: jsonb("metrics")
      .$type<import("@workspace/towbar-core").MonitoringAggregates>()
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.serverId,
        table.entityId,
        table.bucketAt,
        table.resolution,
      ],
    }),
    index("towbar_monitoring_server_time").on(table.serverId, table.bucketAt),
    index("towbar_monitoring_workload_time").on(
      table.deployableId,
      table.bucketAt,
    ),
    index("towbar_monitoring_rollup").on(table.resolution, table.bucketAt),
    check("towbar_monitoring_resolution", sql`${table.resolution} in (30,60)`),
  ],
);

export const scoutAlertRules = pgTable(
  "towbar_scout_alert_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    deployableId: uuid("deployable_id").references(() => apps.id, {
      onDelete: "cascade",
    }),
    name: varchar("name", { length: 100 }).notNull(),
    enabled: boolean("enabled").notNull().default(true),
    severity: varchar("severity", { length: 20 }).notNull().default("warning"),
    environment: varchar("environment", { length: 20 })
      .notNull()
      .default("production"),
    condition: jsonb("condition").$type<ScoutAlertCondition>().notNull(),
    evaluationState: varchar("evaluation_state", { length: 20 })
      .notNull()
      .default("unknown"),
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true }),
    observedValue: jsonb("observed_value").$type<number | null>(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("towbar_scout_rules_due")
      .on(table.evaluatedAt)
      .where(sql`${table.enabled} and ${table.deletedAt} is null`),
    index("towbar_scout_rules_server").on(table.workspaceId, table.serverId),
    check(
      "towbar_scout_rule_environment",
      sql`${table.environment} in ('production','preview')`,
    ),
    check(
      "towbar_scout_rule_severity",
      sql`${table.severity} in ('warning','critical')`,
    ),
  ],
);

export const scoutAlertIncidents = pgTable(
  "towbar_scout_alert_incidents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => scoutAlertRules.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    deployableId: uuid("deployable_id"),
    environment: varchar("environment", { length: 20 }),
    ruleRevision: timestamp("rule_revision", { withTimezone: true }),
    ruleName: varchar("rule_name", { length: 100 }).notNull(),
    severity: varchar("severity", { length: 20 }).notNull(),
    condition: jsonb("condition").$type<ScoutAlertCondition>().notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    conditionStartedAt: timestamp("condition_started_at", {
      withTimezone: true,
    }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolutionReason: varchar("resolution_reason", { length: 80 }),
    lastValue: jsonb("last_value").$type<number | null>(),
    triggerObservation: jsonb("trigger_observation").$type<{
      at: string;
      value: number | null;
    }>(),
    lastNotifiedAt: timestamp("last_notified_at", { withTimezone: true }),
    notificationSequence: integer("notification_sequence").notNull().default(0),
  },
  (table) => [
    uniqueIndex("towbar_scout_one_active_incident")
      .on(table.ruleId)
      .where(sql`${table.resolvedAt} is null`),
    index("towbar_scout_incidents_history").on(
      table.workspaceId,
      table.serverId,
      table.openedAt,
      table.id,
    ),
  ],
);

export const scoutHttpChecks = pgTable(
  "towbar_scout_http_checks",
  {
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => scoutAlertRules.id, { onDelete: "cascade" }),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
    checkedAt: timestamp("checked_at", { withTimezone: true }),
    ruleRevision: timestamp("rule_revision", { withTimezone: true }).notNull(),
    state: varchar("state", { length: 20 }).notNull().default("pending"),
    statusCode: integer("status_code"),
    latencyMs: integer("latency_ms"),
    reason: varchar("reason", { length: 240 }),
  },
  (table) => [
    primaryKey({ columns: [table.ruleId, table.scheduledAt] }),
    index("towbar_scout_http_retention").on(table.scheduledAt),
    check(
      "towbar_scout_http_state",
      sql`${table.state} in ('pending','healthy','failed','blocked')`,
    ),
  ],
);

export const mcpOAuthClients = pgTable("towbar_mcp_oauth_clients", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  redirectUris: jsonb("redirect_uris").$type<string[]>().notNull(),
  secretHash: text("secret_hash"),
  authMethod: text("auth_method")
    .$type<"none" | "client_secret_basic" | "client_secret_post">()
    .notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const mcpOAuthRequests = pgTable(
  "towbar_mcp_oauth_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    clientId: text("client_id").notNull(),
    clientName: text("client_name").notNull(),
    clientLogo: text("client_logo"),
    clientTrust: text("client_trust")
      .$type<"metadata-document" | "unverified">()
      .notNull(),
    redirectUri: text("redirect_uri").notNull(),
    resource: text("resource").notNull(),
    scope: text("scope").notNull(),
    state: text("state"),
    challenge: text("challenge").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
      onDelete: "cascade",
    }),
    grants: jsonb("grants").$type<string[]>(),
    codeHash: text("code_hash"),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    keyId: uuid("key_id").references(() => apiKeys.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    uniqueIndex("uq_towbar_mcp_oauth_code").on(table.codeHash),
    index("idx_towbar_mcp_oauth_expiry").on(table.expiresAt),
  ],
);

export const analyticsSamples = pgTable(
  "towbar_analytics_samples",
  {
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    sampleId: varchar("sample_id", { length: 32 }).notNull(),
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    collectedAt: timestamp("collected_at", { withTimezone: true }).notNull(),
    coverage: jsonb("coverage").$type<{
      requests: boolean;
      pageviews: boolean;
      dropped: number;
    }>(),
    cells: jsonb("cells")
      .$type<import("@workspace/towbar-core").AnalyticsCell[]>()
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.serverId, table.sampleId, table.appId] }),
    index("towbar_analytics_app_time").on(table.appId, table.collectedAt),
    index("towbar_analytics_age").on(table.collectedAt),
  ],
);

export const analyticsRefresh = pgTable(
  "towbar_analytics_refresh",
  {
    id: integer("id").primaryKey().default(1),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("towbar_analytics_refresh_singleton", sql`${table.id} = 1`),
  ],
);

// Host-managed upgrades fail closed until the host runner releases admission.
export const upgradeAdmission = pgTable(
  "towbar_upgrade_admission",
  {
    id: integer("id").primaryKey().default(1),
    jobId: uuid("job_id"),
  },
  (table) => [
    check("towbar_upgrade_admission_singleton", sql`${table.id} = 1`),
  ],
);

export const upgradeLeases = pgTable("towbar_upgrade_leases", {
  id: uuid("id").primaryKey(),
  kind: varchar("kind", { length: 120 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const domainClaims = pgTable(
  "towbar_domain_claims",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    hostname: varchar("hostname", { length: 253 }).notNull(),
    sourceEnvironmentId: uuid("source_environment_id")
      .notNull()
      .references(() => sourceEnvironments.id, { onDelete: "cascade" }),
    desiredAppId: uuid("desired_app_id").references(() => apps.id, {
      onDelete: "set null",
    }),
    activeAppId: uuid("active_app_id").references(() => apps.id, {
      onDelete: "set null",
    }),
    activeDeploymentId: uuid("active_deployment_id").references(
      () => deployments.id,
      { onDelete: "set null" },
    ),
    releasedAppId: uuid("released_app_id").references(() => apps.id, {
      onDelete: "set null",
    }),
    pendingDeploymentId: uuid("pending_deployment_id").references(
      () => deployments.id,
      { onDelete: "set null" },
    ),
    generation: uuid("generation").defaultRandom().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.hostname] }),
    uniqueIndex("uq_towbar_domain_claims_owner")
      .on(table.hostname)
      .where(
        sql`${table.desiredAppId} IS NOT NULL OR ${table.activeAppId} IS NOT NULL`,
      ),
    index("idx_towbar_domain_claims_environment").on(table.sourceEnvironmentId),
  ],
);

export const logCollectors = pgTable(
  "towbar_log_collectors",
  {
    serverId: uuid("server_id")
      .primaryKey()
      .references(() => servers.id, { onDelete: "cascade" }),
    generation: uuid("generation").notNull().defaultRandom(),
    desiredState: varchar("desired_state", { length: 20 })
      .notNull()
      .default("disabled"),
    status: varchar("status", { length: 20 }).notNull().default("disabled"),
    tokenHash: varchar("token_hash", { length: 64 }),
    encryptedToken: jsonb("encrypted_token").$type<EncryptedCredential>(),
    requestedByActor:
      jsonb("requested_by_actor").$type<
        NonNullable<(typeof monitoringAgents.$inferSelect)["requestedByActor"]>
      >(),
    installedVersion: varchar("installed_version", { length: 64 }),
    lastReportAt: timestamp("last_report_at", { withTimezone: true }),
    lastIngestedAt: timestamp("last_ingested_at", { withTimezone: true }),
    errorMessage: text("error_message"),
    supportedContainers: integer("supported_containers").notNull().default(0),
    unsupportedContainers: integer("unsupported_containers")
      .notNull()
      .default(0),
    queueBytes: bigint("queue_bytes", { mode: "number" }).notNull().default(0),
    droppedRecords: bigint("dropped_records", { mode: "number" })
      .notNull()
      .default(0),
    ingestWindow: timestamp("ingest_window", { withTimezone: true }),
    ingestBytes: integer("ingest_bytes").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "towbar_log_collector_desired_state",
      sql`${table.desiredState} in ('enabled','disabled')`,
    ),
    check(
      "towbar_log_collector_status",
      sql`${table.status} in ('disabled','queued','installing','waiting','collecting','failed')`,
    ),
  ],
);

export const logSources = pgTable(
  "towbar_log_sources",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    serverId: uuid("server_id").notNull(),
    containerId: varchar("container_id", { length: 64 }).notNull(),
    workloadId: uuid("workload_id").notNull(),
    workloadName: varchar("workload_name", { length: 120 }).notNull(),
    deploymentId: uuid("deployment_id"),
    previewId: uuid("preview_id"),
    service: varchar("service", { length: 128 }).notNull().default(""),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.serverId, table.containerId],
    }),
    index("towbar_log_source_workload").on(table.workspaceId, table.workloadId),
  ],
);

export const logPolicies = pgTable(
  "towbar_log_policies",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    workloadId: uuid("workload_id").notNull(),
    restricted: boolean("restricted").notNull().default(true),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.workloadId] })],
);

export const logRetentionState = pgTable("towbar_log_retention_state", {
  prunedBeforeAt: timestamp("pruned_before_at", { withTimezone: true }),
  committedSequence: bigint("committed_sequence", { mode: "number" })
    .notNull()
    .default(0),
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  cutoffAt: timestamp("cutoff_at", { withTimezone: true }).notNull(),
});

export const logCollectorRequests = pgTable(
  "towbar_log_collector_requests",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    keyHash: varchar("key_hash", { length: 64 }).notNull(),
    serverId: uuid("server_id").notNull(),
    generation: uuid("generation").notNull(),
    enabled: boolean("enabled").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.keyHash] })],
);

export const repositoryManifests = pgTable(
  "towbar_repository_manifests",
  {
    sourceEnvironmentId: uuid("source_environment_id")
      .primaryKey()
      .references(() => sourceEnvironments.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    commitSha: varchar("commit_sha", { length: 64 }).notNull(),
    manifest: jsonb("manifest")
      .$type<
        ReturnType<
          typeof import("@workspace/towbar-core").resolveRepositoryEnvironment
        >["manifest"]
      >()
      .notNull(),
    paths: jsonb("paths")
      .$type<Record<string, string[]>>()
      .notNull()
      .default({}),
    tree: jsonb("tree").$type<
      import("@workspace/towbar-core").RepositoryTree
    >(),
    observedAt: timestamp("observed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_towbar_repository_manifests_workspace").on(table.workspaceId),
  ],
);
