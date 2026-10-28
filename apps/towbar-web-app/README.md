# Towbar web app

Self-hosted deployment dashboard for Towbar. It reads manifest-owned Apps and
Resources plus Towbar-managed Sources and workspace Servers from the API.
Resources remain nested inside their owning Source alongside Apps; Apps and
Resources expose their own deployment history, while Servers are managed from
the workspace inventory.

The web app also owns `/login` and the locked first-run owner setup. Password
authentication creates the API session directly; Towbar has no separate SSO
application, authorization-code callback, signup, or public password-reset UI.

The Server Overview owns preparation: it recommends a fresh Ubuntu target,
shows the durable setup steps, and keeps deployables visibly in `Server Setup
Pending` until the Server is ready.

App and Resource pages show observed health/drift and bounded runtime actions.
Infrastructure settings and lifecycle are projections of the Source manifest;
removal and restoration happen through Git and Source sync. Secrets are
editor-owned and independent of sync. Global shared secrets provide reusable
workspace values, while App settings store Production and Preview values
separately for build, runtime, pre-deploy, and post-deploy stages. Apps reference
workspace values explicitly with `{{globals.ENV_KEY}}`; there is no automatic
inheritance. Resources support Production runtime secrets only. Owners edit in Form or .env
File mode, with owner-only reveal. File mode loads the selected scope’s values
through one bulk-reveal request. Ordinary reads return metadata, not plaintext.
Saving secrets does not enqueue a deployment.
Server Settings holds connection, concurrency, Cloudflare enablement, SSH, and
Cloudflare credentials.
Source, App, and Resource Settings each expose one operator control for pausing
new automatic deployments. A Source pause applies to all of its deployables;
manual deployment actions remain available.
Apps with Preview enabled expose pull request environments, stable URLs,
expiry, latest deployment status, and an owner cleanup action from the App
page. Preview references resolve only Preview values and are edited independently
from Production bindings.
Database Resource pages expose verified backup policy, manual capture, and
retained S3, Google Cloud Storage artifact metadata. When configured by the manifest, the Resource
connection view exposes non-secret private-network and SSH-tunnel coordinates
for tools such as TablePlus. Owners can restore an individually assured,
retained PostgreSQL or Redis backup through an isolated candidate, validated
promotion, and bounded rollback-volume retention.
Server pages show host capacity on Overview and container capacity in an
Apps/Resources page. Host CPU, memory, Docker disk pressure, and uptime are shown
separately from the runtime inventory, whose CPU and memory values include
compact usage meters. The owning Source repeats those meters in its Apps and
Resources inventories without a separate sync-status column. Server pages also
list unused Docker objects from the latest check and paginated server cleanup
history. Successful Git removal queues server cleanup, including deletion of
exclusively owned persistent volumes. Administrators can request the same
workflow manually and inspect removed objects, skips, and failures.
Trusted SSH host keys can be explicitly untrusted from the Server's Host Keys
page after confirmation.
Deployment details show the immutable Docker image digest and platform together
with the source commit, manifest digest, and selected source-input digest.
Source Settings also contains a Notifications section for Slack and SMTP
destinations. Provider credentials come from the API deployment environment;
unconfigured provider types are not offered. Owners select event categories and supply only a Slack channel ID
or email recipients; recent operational events appear in the application
header without exposing provider secrets in the browser.

## Navigation and monitoring

The secondary sidebar holds page filters and entity sections, using dedicated
paths for detail pages and settings. Filter and entity selections are restored
from permalinks and browser history. On mobile, these controls appear in the
Page menu.

Workspace Performance, Alerts, and Incidents bring Scout measurements and
incident history together. The Vulnerabilities page filters image findings by
severity and links to deployment scan details. The overview pairs deployment
trends with inventory and incident counts, followed by recent deployments.

## Local UI fixture

Run the app against representative synthetic data without starting the Towbar
control plane:

```sh
pnpm --filter towbar-web-app dev:fixture-api
TOWBAR_API_BASE_URL=http://127.0.0.1:4420 pnpm --filter towbar-web-app dev
```

The fixture covers every authenticated page, including nested Source, App,
Resource, Server, Deployment, and Source Sync routes. It
listens on port 4420 to remain isolated from the normal Towbar API development
port.

The local fixture presents Email notifications with SMTP configured and a seeded
destination. Set `TOWBAR_FIXTURE_SMTP_CONFIGURED=false` when starting the fixture
API to review the missing-credentials empty state instead.
Set `TOWBAR_FIXTURE_SLACK_CONFIGURED=true` to review Slack channel destinations,
subscriptions, and the test confirmation. With the flag unset, Slack shows the
missing-credentials empty state.
To test passkey sign-in, start the fixture with `TOWBAR_FIXTURE_AUTH_STATE=signed-out` and open `/login`. Use `2fa-both@example.com` with password `Towbar fixture passphrase 2026`. Password sign-in requires the seeded passkey; `fixture-recovery-one` provides a one-use recovery path. These credentials work only in the local fixture.

The seeded passkey belongs to a virtual authenticator, not your device. Tests can import the public test material from `scripts/dual-factor-fixture.ts` for RP ID `localhost`. The fixture verifies WebAuthn signatures. To test your device, sign in with a recovery code and register a passkey under **My Settings → Passkeys**.

Set `TOWBAR_FIXTURE_AUTH_STATE=passkey-user` to review the passkey table and recovery-code menu directly. Restart the fixture after changing its scripts.

## Documentation screenshots

Start the fixture API with `TOWBAR_FIXTURE_NOTIFICATION_PROVIDERS_CONFIGURED=true`
then start the web app as above. Run
`pnpm docs:screenshots` from the repository root to refresh the light and dark
captures listed in `tools/release-screenshots.json`. Pass screenshot names to
refresh only those views. The upgrade flag enables local scenario controls;
the public demo never exposes them.

The capture tool uses Chrome and records the visible viewport at 2× density.
Set `CHROME_PATH` if Chrome is installed elsewhere, and use
`TOWBAR_SCREENSHOT_ORIGIN` and `TOWBAR_SCREENSHOT_API_ORIGIN` for different local
ports. Run `pnpm docs:check` afterward to verify image dimensions and guide links.
