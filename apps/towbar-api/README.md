# Towbar API

Hono API for Towbar identity, integrations, Source reconciliation, inventory,
deployments, and signed worker callbacks.

The public listener uses port `4020`. Signed worker routes are mounted only on
the separate container-network listener at port `4023`; Compose does not
publish that port to the host.

```sh
pnpm --filter @workspace/towbar-core build
pnpm --filter @workspace/towbar-database build
pnpm --filter towbar-api dev
pnpm --filter towbar-api test
pnpm --filter towbar-api lint
pnpm --filter towbar-api typecheck
pnpm exec turbo run build --filter=towbar-api
```

Production uses separate runtime and migrator PostgreSQL credentials. Keep the internal HMAC secret and `TOWBAR_CREDENTIALS_KEY` outside PostgreSQL. Static integration and notification credentials come directly from the API process environment; the database stores only dynamic provider authorizations such as GitLab OAuth grants and GitHub installations.

The production image includes `node dist/cli/migrate.js` and `node dist/cli/recover-admin.js --email=admin@example.com [--reset-mfa]`.

Better Auth owns password hashing, sessions, MFA, invitation verification and API token mechanics. Towbar's wrappers enforce Admin/Member/Viewer capabilities and reject raw signup/organization/key endpoints. Initial setup atomically creates one team and Admin, then closes permanently. Email-based recovery and optional TOTP are available under Personal Settings. Local operator recovery generates a temporary password, revokes sessions/personal keys and forces replacement. It is never an HTTP operation.

Repository sync reconciles inventory without implicit deployment. Member sync and branch-mapping changes pause environment automation until an Admin reviews and enables it. System GitHub/maintenance effects have scoped grants; queued human/key effects retain actor snapshots and revalidate before execution. See the [Team access guide](../../docs/docs/self-hosting/team-access.md) for the full permission contract.

Relevant pull request events for Apps with Preview enabled enter a Source/PR
coalescing workflow. The API reads the pull request's current state before each
reconciliation, so delayed or out-of-order webhooks cannot recreate a closed
Preview. Admission records independent Preview deployments and releases,
publishes GitHub Deployment statuses, updates one aggregate Preview comment on
the pull request, and keeps production runtime health unchanged. Pull request
merge or closure, retargeting, TTL expiry, manifest disablement, and Admin
deletion converge on the same cleanup admission path.

AWS and Google Cloud backup credentials are workspace-scoped. Servers are
workspace-owned; server identity is `(workspace_id, canonical_ip)`, so independent Sources that
target the same IP share configuration, credentials, trust, and preparation.
Deleting a Source permanently
removes its inventory, backup metadata, runtime
state, and operational history. Backup objects already uploaded to cloud storage remain
external and are not deleted by Source removal.

Apps and Resources share the deployment ledger but remain separate API and UI
entities. Resources support versioned images plus PostgreSQL and Redis presets.
Editor-owned secrets are stored separately from immutable deployable snapshots.
Apps and resources can explicitly reference workspace Shared secrets at
execution time. Preview stages never use Production workload values.
Successful release commits also persist the Docker image content digest and
platform reported by the target host. Existing source, manifest, configuration,
and selected-input digests remain the rest of the provenance record.

Manual App and Resource deployments admit the latest successfully synchronized
revision without synchronizing the Source again. This keeps redeploy admission
fast and lets a redeploy consume current Towbar-managed secrets, resolved
consistently by the API over the authenticated internal execution path. Use `Sync now` for repository or
manifest changes; signed GitHub webhooks keep the configured branch current.
Owners can pause new automatic deployments for an entire Source or one App or
Resource. Paused revisions remain eligible for reconciliation after the pause
is removed; manual deployments remain available while automatic admission is
paused.

Owners can add, replace, and delete variables from an empty configuration.
Resources inherit runtime defaults only; apps support build, runtime, and both
hook stages. Values are encrypted with AES-256-GCM in PostgreSQL. Mutations
require an expected revision, and all public responses are write-only metadata.
See [Managed secrets](../../docs/docs/secrets.md) for API behavior and credential recovery.

Declared Docker networks are created as managed bridge networks on first use
and reused by subsequent apps and Resources on that Server. Operators do not
need to pre-create manifest-owned networks.

Server preparation is a durable workspace operation. Readiness is bound to the
exact normalized Server configuration digest; a Towbar settings change makes
the Server pending again. Deployment admission and automatic-deployment
selection both require a current successful preparation.

Server check history is retained as a rolling window of the newest 500 checks
per Server. Older completed checks are removed as checks finish, while queued
and running checks are preserved until they reach a terminal state.

App and Resource lifecycle is manifest-owned. A deployable missing from the
latest successful Source sync is archived; the same manifest ID reappearing
restores its inventory identity. Successful removal records durable server cleanup
requests in the sync transaction, delivered after commit and retried by maintenance.
Cleanup deletes exclusively owned runtime objects and persistent data, while
preserving deployment history. Re-adding after retirement requires fresh storage.
Towbar has no independent decommission action or lifecycle flag.

Runtime actions, database backups, and scoped orphan cleanup are admitted as
immutable asynchronous operations. Cleanup requires an administrator. Managed
database restores require owner confirmation and a reason, revalidate the
selected retained object, and expose an append-only progress trail. A recurring
Temporal maintenance workflow asks the API to queue read-only server
reconciliation, due manifest-declared cron backups, backup assurance checks,
and expired rollback-volume cleanup.

Owners can configure multiple Source-scoped Slack and SMTP notification
destinations for deployment, Preview, runtime health, backup, and restore event
categories. Slack and SMTP provider credentials come from the API deployment
database as encrypted workspace settings, and unavailable provider types are
omitted from the destination editor. Each attempt resolves current provider
configuration and records a separate durable delivery and bounded retry history.
Test sends and manual retries use the same delivery pipeline. Slack uses a bot
token and channel IDs. SMTP targets must resolve exclusively to public addresses
and are connected through a pinned address with TLS server-name verification.

[Applications](../README.md) · [Repository](../../README.md)
