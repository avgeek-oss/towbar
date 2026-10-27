# Changelog

All notable changes to Towbar are documented in this file. This project follows
[Semantic Versioning](https://semver.org/).

## 2.0.63 (2026-10-27)

### Fixed

- Resolve a newly created public hostname through its authoritative nameservers when the system resolver reports it missing, so a cached negative DNS answer no longer fails the public HTTPS check for new Previews and domains.
- Wait for PostgreSQL's final TCP listener before restoring backups and validating the restored database.

### Changed

- Restructure documentation and the footer to match the shared OSS documentation pattern.
- Cache the scanner database in every CI job and retry GHCR when its mirror is unavailable.

## 2.0.62 (2026-10-27)

### Fixed

- Reconcile Previews for open pull requests after **Sync now** and other syncs that don't deploy, as documented.
- Report missing Preview secrets in the pull request comment instead of retrying silently until reconciliation gives up. An existing Preview stays online and shows why the latest revision was not deployed.

## 2.0.61 (2026-10-19)

### Fixed

- Remove a BuildKit filter that silently prevented unused cache from being pruned during builds, manual cleanup, and hourly maintenance. Preserve active cache records and current and rollback images.

## 2.0.60 (2026-10-19)

### Fixed

- Align Docker cleanup's pending list with removal safety checks, including retained releases on former servers, image aliases, protected workloads, and container references.
- Show removals and failures first in cleanup results, keep skipped objects expandable, and explain attempts that remove no objects.

## 2.0.59 (2026-10-19)

### Fixed

- Bound Docker BuildKit cache before and after builds, during full manual cleanup, and with an hourly timer installed by server setup. Preserve active cache records and report manual cache-cleanup failures.
- Clean obsolete images belonging to active workloads while retaining current and rollback releases. Verify pulled OCI images and digest-only references against workspace and server deployment history.
- Sort repositories alphabetically by the full organization and repository name.
- Make the public-demo stream-expiry test independent of worker startup time.

## 2.0.58 (2026-10-19)

### Added

- Review repository and environment removal outcomes in the UI, REST API and MCP, including ownership transfers, retirements, conflicts and configuration diff paths.
- Define workload icons using a direct `iconUrl` in Service, Compose and Datastore manifests.

### Fixed

- Removing a repository connection now withdraws its declarations and transfers compatible workloads without deleting secrets, volumes or deployment history. Disconnected and archived snapshots no longer cause conflicts.
- Reject stale removal reviews and explain missing destination Repository Secrets before adoption.

## 2.0.57 (2026-10-18)

### Changed

- Remove disconnected repositories without deleting completed workload, deployment, sync, or secret history. Reconnecting the same repository restores its identity and selected environment mappings.
- Show the Latest chip in System Health, simplify status chips, and improve conflict details, audit user selection, and redundant tooltips.

### Fixed

- Keep shared secret previews visible above the editor and stable at the input's left edge. Distinguish shared references with orange text and report specific preview errors.
- Preserve TLS capitalization in deployment progress and status labels.

## 2.0.49 (2026-10-15)

### Added

- Keep log search, workload/server, environment, level, time range, and modal filters in the URL so queries survive reloads and can be bookmarked or shared. Preserve browser history and query undo.
- Show the approximate matching total beside the loaded log count, including newly received live records.

### Fixed

- Localize record timestamps in the log table, including live records and large result sets, while retaining second precision.
- Resume the live trail from the last received cursor after pausing instead of replaying from the original search position.

## 2.0.48 (2026-10-15)

### Changed

- Build release images on native amd64 and arm64 runners, then combine their immutable digests. Avoid QEMU crashes during ARM64 dependency installation.
- Format structured log messages as JSON and expand the body in log details. Hide repeated attributes in the parsed view, with **View raw** and **View parsed** actions beside **Copy** to inspect the complete stored record.
- Keep filters and custom columns available for expanded JSON fields, including double-encoded messages. Preserve plain text and malformed JSON as received.
- Place square filter and search buttons beside the search input on mobile, matching its height. Narrow the settings column while keeping the gear centered.

## 2.0.46 (2026-10-15)

### Added

- Install the OTEL Logs Collector after Caddy during server setup when ClickHouse is configured. Keep manual installation and disable controls in server settings.
- Show ClickHouse log storage usage beside PostgreSQL data storage in System Health, now under Settings.

### Changed

- Replace the legacy log-access setting with native collector status, container eligibility, and connection indicators. Refresh the logs setup and troubleshooting documentation.
- Use spinners for operations in progress, database icons for datastores, and compact cleanup result buttons. Move server IP addresses beside server names.

### Fixed

- Recover Caddy's restart-limit failure during cleanup without starting intentionally stopped services. Preserve routes and workload ownership when cleanup fails.
- Keep relative timestamps current and avoid showing new requests in the future because of a stale clock snapshot.
- Verify fresh installations against the complete migration journal and check the new log storage columns.

## 2.0.45 (2026-10-15)

### Added

- Add optional centralized container logs with external ClickHouse storage, YAML retention settings, per-server OpenTelemetry collection, and shared REST/MCP authorization.
- Add a workspace log explorer with stacked severity counts, searchable workload filters, custom time ranges, infinite scrolling, and contextual JSON field actions.
- Save each user's log table columns, order, custom fields and widths on the server. Drag header borders to resize columns.
- Support Command-Z and Ctrl-Z to undo date-range and filter changes while preserving native text undo.
- Use the shared calendar and time picker in logs and server/workload monitoring.

## 2.0.44 (2026-10-14)

### Fixed

- Show a compact spinner beside Docker cleanup in the sidebar while cleanup is in progress.
- Batch server cleanup route removals into one validated Caddy reload, avoiding restart rate limits and unnecessary reloads for workloads without routes. Preserve staged routes and domain ownership on failure so partial cleanup can be retried safely.
- Distinguish Caddy validation and apply failures from Docker inspection failures in cleanup results.
- Discover service and deployment icons from HTML declarations and API Link headers, with a `/favicon.ico` fallback and expiring retries. Keep preview icons scoped to their own hostname.
- Expose `/favicon.ico` publicly on Towbar's web and API origins, redirecting to the packaged PNG artwork with its correct media type.

## 2.0.43 (2026-10-14)

### Changed

- Queue one durable cleanup attempt per affected server after a valid sync removes workloads, including deletion of their exclusively owned persistent volumes. Preserve active workloads, rollback artifacts, shared resources, and deployment history.
- Use the same server cleanup workflow for **Request Cleanup**, and show paginated sync/manual attempt history with results and failures.
- Show named cleanup results in a wide table modal, with entity type icons and relative timestamps. Improve cleanup pagination and clarify the pending objects column.

### Fixed

- Allow removal of archived workloads with conflicting retained domain owners without releasing ownership before their routes are retired. Keep active assignments and explicit domain handoffs protected.

## 2.0.42 (2026-10-13)

### Changed

- Install the shared design system and Mintlify documentation tools from public npm without GitHub package credentials.
- Adopt the shared mobile API-key table, consistent MCP client names and icons, and table layouts on mobile.

## 2.0.41 (2026-10-12)

### Added

- Support DNS-only Cloudflare routing with `tls.proxied: false` while retaining
  automatic DNS records and Caddy certificates.

### Changed

- Show consistent MCP client names, icons, and connection tables on desktop
  and mobile.
- Include deployment status in the deployment overview.

### Fixed

- Report the underlying DNS, connection, or TLS failure when public endpoint
  health checks cannot connect, instead of reporting HTTP status 0.

## 2.0.40 (2026-10-11)

### Fixed

- Allow rolling deployments when combined container CPU limits exceed the host
  CPU count. Keep per-container CPU limits, memory headroom checks, and
  health-based promotion in place.

## 2.0.39 (2026-10-10)

### Fixed

- Allow administrators to explicitly authorize MCP deployment and infrastructure
  operations with the `mcp:admin` OAuth scope and password or passkey confirmation.
- Preserve the permissions of existing OAuth connections; administrator access
  requires a new consent grant and remains limited by the user's current role.

## 2.0.38 (2026-10-10)

### Fixed

- Show Not deployed for services and datastores without deployment history.
- Include the configured datastore image version beside its engine name.

## 2.0.37 (2026-10-10)

### Added

- Show host restart and hardware change markers in server Performance charts.
- Refresh server hardware and instance type metadata when Scout detects changes.

### Changed

- Publish installers, CLI downloads, schemas, checksums, and validated release
  metadata as GitHub Release assets. Keep API, worker, and UI images in GHCR.
- Use GitHub Releases for CLI and System Health update discovery, removing the
  separate download host and publication broker from future releases.

## 2.0.36 (2026-10-10)

### Added

- Support PostgreSQL 18 as a managed datastore using an immutable image override.
  PostgreSQL 17 remains the default. PostgreSQL 18 mounts its data volume at
  `/var/lib/postgresql`, matching the upstream image layout.

### Changed

- Require OAuth authorization for MCP connections. Personal and team API keys
  remain available for the REST API.

### Fixed

- Reject mutable and unsupported PostgreSQL image tags before deployment.

## 2.0.35 (2026-10-09)

### Changed

- Show Scout Agent CPU and memory summaries as area charts with individual
  tooltips and a 30-minute range in the column heading.
- Keep CPU and memory meters compact across server, service, datastore and
  repository tables. Show deployment type and environment in server workload
  tables, place IP after memory capacity, and show sync status before branch.
- Use the container-only Towbar logo, native Sketch favicon and social card,
  and higher-resolution Scout artwork. Include the editable branding source.
- Separate dashboard and public API origins, use YAML for runtime configuration,
  and derive the gateway domain from the dashboard URL.

### Fixed

- Make AWS logos black in light mode and emphasize repository names after the
  owner prefix.
- Remove proxy trust configuration and initialize runtime YAML directly.

## 2.0.34 (2026-10-08)

### Changed

- Group deployment progress into Validating setup, Preparing artifacts,
  Deploying artifacts and Finishing up, with expandable detailed steps and
  traffic switching inside Deploying artifacts.
- Use progress meters for server CPU and memory usage and Ban icons for
  cancellation, stopped workloads and cancelled progress.
- Adopt design system 1.2.12 for a dedicated System Health update link and
  clearer passkey confirmation actions.

### Fixed

- Keep service and datastore identities inside their table columns and cap
  terminal action underlines to their content.
- Darken yellow chart series in light mode and match deployment and restart
  marker text to their fills in both themes.
- Stop progress timers after failure or cancellation and distinguish missing
  historical steps from work waiting to start.

## 2.0.33 (2026-10-08)

### Changed

- Show status immediately after the row identity across inventory, operation,
  monitoring, and notification tables. Keep deployment duration beside the
  requested time, and move commit details to the end of history tables.
- Keep repository status visible below the wide-screen breakpoint and reduce
  datastore identity column width on smaller desktop screens.

### Fixed

- Make the default service and datastore inventory actually group by server,
  matching the selected view toggle.
- Move manifest code padding inside the scrolling editor so the first and last
  lines stay inset, and remove the permanent deployment-log link underline.

## 2.0.32 (2026-10-08)

### Changed

- Adopt the published design system 1.2.11 and shared documentation kit 0.1.5.
- Default deployments to Group by Server and use consistent entity icons,
  favicons, environment chips, and secret input widths.
- Show analytics storage separately in a stacked database storage chart, add
  shorter analytics time ranges, and use gradient fills for server usage charts.
- Align documentation buttons, theme colors, SEO metadata, OSS footer links,
  and high-resolution dashboard screenshots with the shared documentation kit.

### Fixed

- Keep searchable dropdown inputs inside their popovers and improve chart axis
  label spacing and yellow syntax-key contrast.

## 2.0.31 (2026-10-08)

### Changed

- Adopt design system 1.2.9 for shared authentication, account and team settings, profile images, password changes, passkey recovery, notification menus, and backend recovery.
- Use a yellow accent theme, route-based breadcrumbs, consistent menu controls, and improved table and notification styling.

- Keep passkey verification cancellable until server verification begins.
- Keep the CLI, installer, MCP server and OpenAPI metadata aligned with the service release version.

- Use the shared OSS documentation kit for Mintlify homepage layouts, header behavior and themed screenshots while keeping product content and navigation in Towbar.

- Require a name, Read-only/Edit/Administrative permissions and an explicit expiry for personal and team API keys. Enforce the selected grants across REST and MCP.

### Fixed

- Reconnect automatically when the backend is unavailable during startup, while keeping authentication failures separate and preserving an existing session during background outages.

- Show a retry state when the notification inbox cannot be loaded, and retain existing rows when pagination fails.

- Notifications now use durable per-user read receipts and an explicit Mark all as read action. Unread events remain available through pagination; read events remain visible for 24 hours after acknowledgement. Opening the menu no longer marks events read, and marking read does not delete history.

- Upgrade the MCP SDK to 1.31.0 to address GHSA-6qxp-vccf-f47h.
- Upgrade the image-processing dependency to sharp 0.35.5 to address GHSA-wq5f-xc86-pv6w.

## 2.0.30 (2026-10-05)

### Added

- Connect multiple GitHub organizations or accounts and move repository sources
  after verifying access through the destination installation.
- Installers, CLI downloads and schemas are published at `oss.avgeek.ltd/towbar`.
  Releases use short-lived, repository-scoped credentials and become available
  only after a fresh installation passes health and restart checks.

### Changed

- Browser contracts are independent of server code. Builds share one dependency
  graph, and release publication uses a small, separate dependency set.
- Removed optional Sentry telemetry and its configuration.
- Settings navigation, invitation tables and integration details use simpler
  headings, copy and action alignment.
- Page content uses 16px horizontal padding and 80px bottom padding at every
  viewport size. Page headings use 20px padding above and below, and header
  padding aligns the navigation icon with the page content.
- Service and datastore action menus follow the Deploy button. Notification
  badges sit slightly higher and farther right on the bell button.
- Widget headings omit decorative icons across overview, configuration,
  monitoring, backup, and settings pages, retaining provider identities and
  deployment-alert indicators.

### Fixed

- Navigation toggle hover backgrounds follow the pointer instead of a retained
  hover state after sidebar transitions, while keeping pressed and focus feedback.
- Modal and incident drawer titles align with their close buttons. Header rows
  reserve space for the close control when titles wrap on narrow screens. Overlay
  bodies and footers use consistent 16px gaps and dialogs use 20px outer padding.

## 2.0.29 (2026-10-03)

### Fixed

- Unrelated domain ownership conflicts no longer block source syncs or deployment
  admission. Reconciliation checks the affected environment or workload's
  hostnames against workspace-wide ownership evidence, including retained
  releases and active or released claims. Ambiguous legacy domains remain
  protected without blocking unrelated workloads.

## 2.0.25 (2026-10-01)

### Added

- Services and datastores show their synced manifest under Operate, with the
  workload's environment and file selected automatically.
- Repository breadcrumbs include a searchable selector that opens the selected
  repository's Environments page. Sync breadcrumbs let users switch between
  syncs, with status, environment, branch, and timestamp shown in the list.
- OpenTelemetry collectors and related OCI images reuse product logos instead
  of the generic icon, including ClickHouse Keeper and SigNoz Collector.

### Changed

- Inventory group headings use smaller text and icons.
- Deployment breadcrumbs include the workload's Deployments page and the
  deployment ID. The secondary sidebar identifies the deployment by its ID.

### Fixed

- SigNoz artwork is centered on desktop and mobile.
- Manifest links use the correct GitHub or GitLab provider, preserving
  self-hosted GitLab URLs and nested namespaces.

## 2.0.24 (2026-10-01)

### Added

- Services and Datastores can be grouped by server, with a workload count for
  each host.
- OCI services and datastores support custom commands, mounted configuration
  files, and container settings. Runtime details appear in the dashboard, and
  independent-service examples cover SigNoz and ClickHouse.

### Fixed

- The reconnecting screen centers its message with padding on mobile and uses
  a yellow loading indicator.
- The gRPC dependency is patched to version 1.14.5.

## 2.0.23 (2026-09-30)

### Changed

- Emails use a white background throughout, with the gray outer area and rounded
  content card removed.

### Fixed

- Host-log collectors can start when a non-root deploy user has Docker access
  but cannot traverse Docker's root-owned data directory. Read-only path checks
  use passwordless sudo when needed, while retaining mount safety checks.
- Candidate startup failures appear in redacted deployment logs. Docker data-root
  checks that cannot run report the deploy user's required passwordless sudo access.

## 2.0.22 (2026-09-30)

### Changed

- Full administrative API keys follow Towbar's current automation permissions,
  including capabilities added by upgrades. Existing complete, unmodified admin
  keys are recognized during migration. Scoped keys and MCP OAuth consent retain
  their saved grants; personal keys permanently narrow when their owner is
  demoted, and queued work cannot gain new permissions through an upgrade.

### Fixed

- Compose deployments can commit their release metadata without being rejected
  as image deployments. The API verifies that release metadata matches the
  deployment kind.
- Interrupted Compose deployments reconcile the host's committed release before
  cleanup, preserving the running release and restoring the previous release
  when the replacement did not commit.

## 2.0.21 (2026-09-30)

### Changed

- Deployment progress uses yellow for running steps, smaller descriptions, and
  compact timestamps such as `18:52 (<1s)`. Unfinished steps hide the finished
  timestamp, and log links use muted text with dashed underlines.
- Mobile sidebars truncate long labels. Notifications show dates below entity
  details, and secret variables have more space between names, values, and rows.
  Input text appears smaller while keeping a 16px CSS font size.
- Analytics uses HTTP analytics and Web analytics labels and shows summary
  metrics in two columns on mobile. Truncated city names open a tooltip on hover
  or tap, and empty tables use smaller, muted text. Mobile hides the Filters
  action; performance menus omit the 30-minute and 15-day ranges.
- Incident details, General settings, notifications, and progress cards remove
  redundant headings, icons, and controls.
- Operational emails use readable labels, rounded measurements with units,
  compact references, and links to the relevant deployment or incidents page.
  SSH command failures show connection guidance or identify the failed step.

### Fixed

- Incident charts include the triggering measurement bucket and retain the
  initial reading for incidents created after this upgrade, even after sample
  cleanup. Single readings appear as dots, and recovered charts end five minutes
  after recovery instead of extending to the current time.
- Compose deployments prepare state safely for non-root users on fresh hosts.
  Failed replacements report whether the previous release restarted, and
  Compose deployment links open under Services.
- Table description links highlight their dashed underline and arrow on hover,
  including links in Recent deployments.
- Updated `brace-expansion`, `fast-uri`, and `ip-address` to patched versions.
  Integration test images use official Ubuntu repositories over HTTPS, retry
  package downloads, and stop when package indexes cannot be loaded.

## 2.0.20 (2026-09-30)

### Changed

- The Domains table shows each route's destination and function in separate
  columns, with clear markers for primary and alternate domains.

### Fixed

- Compose deployments move through their progress steps in the right order so
  they can finish successfully. MCP inspection can read Compose services again.
- Integration checks build shared API and worker packages in order, preventing
  intermittent build failures.

## 2.0.19 (2026-09-29)

### Added

- Services have a Domains page showing their public addresses and TLS settings.
  Compose services can use Cloudflare DNS for certificate renewal.

### Changed

- Compatible CLI installations and upgrades enable dashboard upgrades
  automatically.
- Service and Datastore breadcrumb menus group options by repository, with
  smaller headings and search by repository name.
- First-deployment checks use the same text sizes as deployment progress. The
  secondary sidebar and tables with footers have less bottom padding.
- Release scripts derive their versions from the root package version. Checks
  reject an installer or CLI that has not been regenerated after a version bump.

### Fixed

- The upgrade modal stays open while the API restarts. Temporary connection
  failures no longer redirect signed-in users to the sign-in page.
- Server details return the saved container log collection setting.
- Compose deployments check DNS credentials and update DNS records when changing
  between public access and a Cloudflare Tunnel.
- Updated dashboard, MCP, authentication, email, and development dependencies
  with security and reliability fixes.

## 2.0.18 (2026-09-29)

### Added

- Admins can allow a Service to collect Docker container logs on a server.
  Collectors require persistent storage and CPU and memory limits.

### Fixed

- Upgrading legacy image workloads to Services preserves saved secrets, workload
  IDs, volumes, and deployment history. Conflicting manifest IDs and unsupported
  volume paths stop the upgrade with recovery guidance. Installations that already
  lost records in an earlier upgrade still need to restore them from a backup.
- Failed or interrupted SSH credential checks no longer leave later checks on
  the same server stuck in the queue.
- The demo header stays visible beneath the countdown bar while scrolling.
  Both sidebars adjust to the bar's height, including when it wraps on mobile.
- Updated HTTP and email dependencies with security fixes.

## 2.0.17 (2026-09-28)

### Added

- Admins can review and start an upgrade from System Health when the optional
  host upgrade service is enabled. Progress, success, and failure stay in the
  same modal. Deployments and operations pause while Towbar upgrades.
- Website Analytics adds time spent, bounce rate, exit pages, and outbound
  websites with Scout Agent 1.2.0. Bounce rate and exit pages use optional visitor
  estimates. Existing pageview totals are preserved.
- Analytics filters can combine paths, referring websites, countries, cities,
  and browsers. Country names, flags, browser logos, and website favicons make
  the results easier to read.
- Services and Datastores can be grouped by environment to compare production,
  staging, and other environments across repositories.

### Changed

- The deployment trend chart is shorter on mobile. Integration pages show safe
  configuration details without displaying stored credentials. Documentation
  and screenshots reflect the current UI.
- Sign-in requests a passkey automatically when both a passkey and an
  authenticator app are available. The code and recovery options remain usable.

### Fixed

- Select menus scroll with a mouse wheel or touch while their search field
  stays in place. Mobile users can swipe right within the dashboard to open
  the sidebar.
- External secret details identify their provider consistently.
- Production builds keep button, modal, and table styles when Analytics loads
  before the global stylesheet.

## 2.0.16 (2026-09-27)

### Added

- MCP clients can sign in through OAuth with explicit consent and personal
  tokens that expire after 30 days. API keys show the token type and saved MCP
  client attribution; audit actions include that attribution. Existing API keys
  keep their permissions and expiry.
- Services can opt in to Scout Analytics for HTTP requests and pageviews. The
  dashboard shows traffic, response times, errors, paths, referrers, and
  previous-period comparisons. Optional browser tracking adds pageviews and
  visitor estimates; local country data is checked for updates daily.
- Service alert rules can create incidents when HTTP requests or pageviews rise
  above or fall below a chosen count. Missing collection data is treated as
  unknown rather than zero traffic.
- An opt-in public demo gives each visitor an isolated, ten-minute sandbox with
  sample Services, Datastores, servers, and safe simulated actions.

## 2.0.15 (2026-09-27)

### Added

- Services and Datastores are first-class workload types, with dedicated
  inventory, deployment details, and managed engine configuration.
- Deployment notifications can be limited to failures, and System Health shows
  database storage history and available Towbar updates.
- The dashboard has dedicated 404 and 500 pages. Documentation adds individual
  use-case guides and refreshed product screenshots.

### Changed

- The self-hosted runtime configuration path is `/etc/towbar/config.yml`.
  The updated CLI renames an existing `/etc/towbar/towbar.yml` during upgrade
  or restart while preserving its contents and permissions.
- Service and Datastore manifests use the corresponding repository directories.
  Notification and secret guides reflect the current workload model.

## 2.0.14 (2026-09-26)

### Changed

- Cloudflare DNS TLS is selected by each App or Resource manifest instead of a
  server setting. Towbar prepares the target server's Caddy DNS module when a
  deployment needs it.
- Resource image names use the full width of their configuration row. Secrets
  editing shows referenced values on hover and requires revealing a masked
  value before editing it in Form view.

### Fixed

- Deployments and previews requesting Cloudflare DNS TLS are rejected before
  queuing when the Cloudflare runtime integration is not configured.
- Repository rows no longer prefetch a removed manifest route, and the
  repository list no longer polls its inventory every five seconds.
- Obsolete source-level secret references are removed from the editor and docs.

## 2.0.13 (2026-09-26)

### Added

- Servers can have an optional name, shown in navigation and inventory alongside
  a separate IP column. Naming a server leaves its connection and deployment
  configuration unchanged.
- App and Resource manifests can route Deployments, Backup & Restore, and
  Alerts & Incidents to additional Email, Slack, Discord, and Telegram
  destinations. Subscriptions take effect after a successful environment sync,
  while provider credentials remain in runtime configuration.

### Changed

- Notification deliveries share one global history with entity and resource
  filters. App and Resource notification pages show their synced destinations
  together in one table.
- Preview settings live in App configuration, and preview rows link directly to
  their deployments. Secret targets distinguish mainline from previews, while
  the App sidebar shows the current preview count.
- App and Resource navigation groups deployment work under Ship and moves
  Notifications into Settings. Desktop tables size columns to their content.

### Fixed

- Switching App or Resource environments preserves the current view while the
  next environment loads. Server setup shows a live countdown before returning
  to Overview.

## 2.0.12 (2026-09-24)

### Added

- Self-hosted runtime settings use `/etc/towbar/towbar.yml`, with grouped
  provider credentials and validation before lifecycle commands. Existing
  installations convert their supported settings while preserving rollback
  configuration; fresh installations create YAML directly.
- Email, Slack, Discord, Telegram, and webhook notification destinations can
  be managed and tested in the control plane. Destinations choose Deployments,
  Backup & Restore, and Alerts & Incidents independently, while provider
  credentials remain in runtime configuration.
- Notification provider pages show configuration empty states and destination
  tables, with updated self-hosting and integration guides.

### Changed

- Repository connections, branch mappings, and manual syncs require Admin
  access. Branch changes retain the existing automation pause state, and the
  redundant Environment automation card is removed.
- Apps and Resources open in the unified inventory view by default. Inventory
  and deployment rows omit repeated branch labels; the deployment queue shows
  an environment chip and live elapsed duration with compact, consistent status
  indicators.
- Cloudflare TLS switch copy uses regular-weight text and tighter spacing.

### Fixed

- Interrupted server checks become failed checks, and maintenance recovers
  stale running records so scheduled checks resume after worker restarts.
- Line-chart tooltips follow the pointer without a delayed transform, and
  switching integration providers keeps the sidebar mounted to avoid logo
  flashes.

## 2.0.11 (2026-09-24)

### Added

- Scout metric and public HTTP alerts can require a sustained breach for 1, 2,
  5, 10, 15, or 30 minutes before opening an incident.
- App, Resource, and Server detail breadcrumbs offer a searchable switcher with
  the corresponding application, resource, or cloud-provider logo.
- App and Resource overviews show the effective repository branch beside the
  repository.

### Changed

- Scout alert actions are Pause and Resume, with yellow controls, while Delete
  is red. New rules start active, and create and edit forms no longer show an
  enabled checkbox.
- SSH keys move into the primary Manage sidebar, and key-type chips are yellow.
- Resource inventory gives logos, names, and status indicators more room;
  environment chips and branch details are consistent across inventory and
  deployment lists.
- Overview deployment charts use separate colors tuned for light and dark
  themes. Server setup uses yellow progress indicators and calls its pending
  action Resume Setup.
- Account navigation adds a repository link and uses Sign out for its red
  action. Secret editors, branch controls, revision links, and tooltip borders
  have more consistent spacing and interaction states.
- The self-hosting and dashboard guides include refreshed release screenshots
  and current account, server-capacity, and deployment details.

### Fixed

- Switching detail sections keeps the secondary sidebar mounted, prevents
  identity images from flashing after text, and avoids a blank interval when
  opening deployment details.
- Deployment details keep their shell visible during loading and preserve the
  current snapshot during refresh. Links open the intended section directly.
- After server setup queues its first check, the setup page returns to Overview
  after five seconds.
- Tooltips that repeat their trigger appear only when text is clipped; long
  revision tooltips stay within the viewport. Secret-row connector lines are
  readable in both themes.

## 2.0.10 (2026-09-24)

### Added

- Notification history can be cleared from the header, and each notification
  opens the app, resource, server, or settings page that needs attention.
- The sidebar identity opens an account menu with profile, preferences,
  security, API keys, changelog, documentation, feedback, and sign-out actions.
- Server inventory shows CPU and memory utilization beneath capacity, with the
  measurement time available on hover and both capacity columns visible on mobile.
- Deployment lists and the overview's recent deployments show app or resource
  logos when available, plus the workload type beneath its name.
- Passkeys show their creation date beneath the name.

### Changed

- Deployment history gives requested time, branch, and commit their own table
  columns.
- Authentication panels use tighter padding on mobile screens.
- Deployment and resource overviews use clearer environment chips, simpler
  headings, a highlighted manual deploy action, and roomier mobile image names.
- Deployment comparisons use clearer assessment colors and a shorter navigation
  label; the status tooltip puts requested and finished times on separate lines.
- Overview illustrations have spring hover motion, and timestamp tooltips align
  to the left of their values.
- Repository onboarding uses tighter environment mapping rows, while inventory
  shows repository context in a branch tooltip instead of a separate column.
- Shared-secret empty states center the Add Variable action, and variable rows
  keep the delete control beside the name on desktop and mobile. Secret editors
  have tighter mobile spacing and desktop leader lines.
- Resource health-check settings have their own section. Cloudflare TLS shows
  its brand beside DNS mode and uses clearer validation copy; displayed domain
  names have a muted underline.
- Performance and incident filters sit in their page headers. Mobile performance
  filters and labels fit more cleanly, and Scout Agent setup uses clearer copy
  and more compact actions.
- The server terminal has a simpler layout and asks for confirmation before
  disconnecting. Completed setup checks no longer clutter server navigation.
- Widget headers use 22px buttons, widget footers use quieter descriptions,
  setup-step details use extra-small text, and `text-xs` is 0.72rem.
- Mobile small buttons are 28px tall with 12px horizontal padding; mobile tables
  size columns to their content, and page titles use a smaller inset.
- Credential and Cloudflare TLS widgets omit icons already present in their page
  headings. Popovers have a subtle edge, and the sidebar identity gradient
  appears only on desktop hover.
- The sidebar identity has more space between its labels, and sign-out
  confirmation shows an icon on its action button.
- Email senders include a display name, and message previews use complete
  sentences. The verification email has more space between its action and link.
- Notification integration settings identify configured routes and their
  destinations more clearly.
- Session revoke controls retain their label while a request is in progress;
  team member names no longer carry a redundant self label.
- Auto-deploy descriptions use normal weight, select controls reserve room for
  indicators, and editor tab labels stay stable while loading.

### Fixed

- Detail navigation keeps its loading state stable instead of briefly showing
  generic page titles, and cached product artwork no longer flashes during
  navigation.
- The sign-out action keeps its danger background visible without requiring
  hover, and Escape no longer closes the mobile sidebar.
- GitLab branch selectors load all available branch pages, including branches
  found by searching beyond the first page.
- Verification emails are dispatched promptly after being queued.
- System health reports the packaged release version and refreshes Temporal
  checks automatically instead of relying on manual checks.
- Safari reauthentication no longer prompts to save the password.
- Deployment chart date labels no longer clip, and mobile Actions headers align
  with their controls.
- The deployment queue and notification center render reliably through
  navigation and refreshes.

### Removed

- The verification dialog's request-limit explanation, failed environment
  discovery fallback copy, and redundant comparison-gap explanation.

## 2.0.9 (2026-09-23)

### Added

- First-deployment guidance now reports whether required app or resource
  secrets still need configuration and offers the next relevant action.
- Successful server setup immediately queues a health check so capacity and
  workload status refresh without waiting for the scheduled check.

### Changed

- Server Preparation is now named Server Setup throughout the dashboard and
  documentation.
- Resource Settings places Secrets before Backup and Restore, and Repository
  environment actions remain on one row on narrow screens.
- Secondary navigation counts use the same muted treatment as primary
  navigation counts.

### Fixed

- YAML-declared secret values can be cleared from their app or resource while
  preserving the declaration for later configuration.

## 2.0.8 (2026-09-23)

### Fixed

- GitHub repository connections store the selected installation's internal
  record ID, allowing newly connected repositories to be imported successfully.

## 2.0.7 (2026-09-23)

### Changed

- SSH host verification now selects the ED25519 host key when available and
  presents one recommended fingerprint for approval.
- Successful SSH verification for a pending server now continues directly to
  server preparation.
- Server preparation timelines use their status icons without duplicate status
  chips, with tighter alignment and a simpler preparation action.
- Mobile navigation, page headings, form controls, account identity and
  integration layouts use the available screen width more effectively.
- Dashboard queue and deployment-trend summaries stay concise on narrow screens,
  and integration cards avoid repeating page-level icons, help and empty-state
  status.

### Fixed

- Fresh Ubuntu servers no longer stop before Docker installation when optional
  conflicting packages are absent.
- SSH checks and server-preparation steps return actionable, step-specific
  guidance when the remote command exits without diagnostic output.
- Narrow integration pages keep widgets at full width until the remaining
  content area can comfortably fit two columns.

## 2.0.0 (2026-09-20)

### Added

- Persistent app files through manifest-defined volumes, with separate storage
  per environment and preview, explicit initialization and retained data on removal.
- Manifest-defined application jobs with UTC schedules, manual runs, execution
  history, timeouts and bounded output. Jobs use the deployed image and its mounts.
- An administrator browser SSH terminal with pinned host keys, session checks
  and audited connections.
- Team onboarding, Admin/Member/Viewer access control, direct member creation,
  email-scoped invitations, member role management and team audit logs.
- Personal and team API keys with role-aware permission limits, plus personal
  profile, verified email change, password, session, authenticator and passkey
  management.
- Persistent server preparation checklists with inspection details, prerequisite
  installation output and terminal logs.
- Host-only administrator recovery and two-factor reset commands, plus uninstall
  and recovery documentation.
- Named environments for apps and resources, including production and staging.
  Each instance has its own configuration, server assignment, deployment history,
  secret values, volumes, backups, and monitoring identity.
- Repository onboarding discovers declared environments and lets owners select which
  to connect. Branch mappings, branch changes, disconnects, and reconnects are
  managed in Towbar. Initial connection and mapping changes sync without deploying.
- Required secret declarations create unset editor slots during successful sync.
  Existing values and shared references are preserved for unchanged keys; removed
  declarations remove their saved values. Missing values block deployment while
  allowing configuration sync.
- Environment controls and filters across Repository inventories, entity pages,
  deployments, and monitoring, with environment selection retained in permalinks.
- Separate editor schemas and runnable examples for the v2 repository, app, and
  resource configuration files.

### Changed

- **Breaking:** replace the v1 deployment manifest with root `towbar.yml`
  (`version: 2`) and one entity per `*.app.yml` or `*.resource.yml` under
  `.towbar/apps/` and `.towbar/resources/`. Entity files declare shared settings
  and explicit environment overrides. Objects merge; arrays replace.
- **Breaking:** branch names belong to Repository environment mappings in Towbar.
  They are no longer configured in YAML or stored as one branch per Repository.
- **Breaking:** workloads reference the IP address of a server registered in
  Towbar. Credentials and preparation settings remain in Towbar.
- **Breaking:** secret keys for app/resource instances are declared in YAML;
  Form and File modes edit their values. Preview secrets are isolated by target
  environment and do not fall back to persistent environment values.
- Preview eligibility follows the PR base branch's mapped environment and requires
  both environment-level enablement and app opt-in. PR configuration does not
  reconcile persistent instance settings or required-secret slots.
- Environment sync resolves one immutable commit, validates the complete effective
  configuration, and reconciles atomically. Invalid or unavailable configuration
  preserves prior state; mapping revisions prevent stale jobs from overwriting it.
- The dashboard now calls source-control connections Repositories. Existing REST
  `/sources` paths and stable MCP tool identifiers retain their API names.
- Integration credentials are supplied by the Towbar runtime environment. The
  dashboard exposes only providers with complete runtime configuration; GitHub
  App installation and GitLab OAuth authorization remain interactive.

### Fixed

- Redis restores load RDB snapshots before enabling append-only persistence,
  preventing an empty database from passing restore health checks.
- Completed environment syncs remain successful when delayed retries or lost
  queue responses arrive after the worker has progressed.
- Declared secret inputs use the full card width on mobile.
- Deployment and rollback admission reject disconnected, stale, archived, or
  unprepared targets, and retain the selected environment in deployment snapshots.
- Runtime identities use instance IDs, preventing sibling environments from
  sharing deployment cleanup or resource-operation identity.
- Resource deployment execution no longer requests GitHub build credentials when
  it only needs to pull an image.
- Preview cleanup reports Docker failures and also removes runtime-labeled
  candidates that have no committed release record.
- Non-root Trivy execution mounts the readable image archive without exposing its
  private parent directory to the scanner container.
- Branch mapping errors remain visible beside the edit form while preserving
  the entered branch and previous mapping.
