# Public Towbar demo

`try.towbar.dev` runs the current dashboard against disposable, simulated
Towbar data. It is a separate application, image, host, and network from the
production control plane. No production API, worker, Temporal, database,
credentials, SSH agent, or Docker socket is connected to it.

This directory is the deployable stack and operator runbook. Public activation
requires the reviewed change in a release, its published demo image, a dedicated
host, and DNS. Adding this stack to the repository does not activate the domain.

## Session and reset decision

Research checked on 2026-09-27:

- [Grafana Play's investigation walkthrough](https://grafana.com/docs/grafana-cloud/learn-and-build/visualizations/simplified-exploration/traces/get-started/example-investigation/)
  offers a real product UI with example data and explicitly warns that public
  demo data changes and may reset. This supports realistic seeded data and a
  visible explanation of reset behavior, but does not establish private sessions.
- [Killercoda's scenario lifetime documentation](https://killercoda.com/creators)
  describes bounded environments, a warning near expiry, and reloading to obtain
  a new environment. Its free one-hour lifetime is designed for tutorials.
  Towbar chooses ten minutes for a shorter product exploration; this is our
  capacity/product choice, not a claimed industry standard.
- [OWASP session guidance](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
  supports unpredictable, server-issued IDs, secure cookie attributes, and
  server-side expiration. An IP address cannot distinguish people behind one
  NAT/proxy and can change during a visit. It is an abuse signal, never identity.

| Model                                           | Cost and behavior                                                                              | Decision                                          |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Shared read-only fixture                        | Lowest memory; useful for browsing, no personal experiments                                    | Insufficient for trying actions                   |
| Shared mutable fixture with global reset        | Simple process, but visitors see each other's edits; resets interrupt everyone                 | Rejected                                          |
| One process with session-indexed fixture stores | Lower per-visitor overhead, but every fixture module and future state must be scoped correctly | Consider if measured traffic warrants refactoring |
| One fixture worker per random browser session   | Reloads all module state; bounded worker memory and count; no tenant-ID plumbing               | Selected                                          |

The factory currently contains both closure state and module-level mutable
collections. Calling it repeatedly in one isolate does **not** isolate those
collections. A worker loads a fresh module graph. Workers are data isolates,
not OS security sandboxes; visitors cannot submit executable code. The network
and container restrictions below provide the additional runtime boundary.

## Visitor behavior

1. The gateway redirects a new visitor to `/demo`. Start demo creates an
   independent fixture worker and a random 256-bit cookie. No email is required.
2. `__Host-towbar-demo` is host-only, Secure, HttpOnly, SameSite=Strict, and valid
   for 600 seconds. A separate local-only cookie works on loopback HTTP for QA.
3. The current dashboard displays repositories, Services, Datastores, server
   monitoring, deployment history, settings, and sample integration status.
   Secret reveal/editing, server and team changes, source connection flows,
   notification tests, jobs, backups/restores, and runtime actions mutate that
   worker only. Deploy creates a simulated deployment which moves
   through build/start/success and streams updates in about six seconds.
4. A persistent notice identifies the demo, shows time remaining, and offers
   Reset demo and End demo. It warns during the final minute. Reset destroys the
   old worker and cookie and seeds a new sandbox; it is rate-limited like start.
5. Expiration is absolute, independent of activity. A timer terminates the
   worker and open streams even if the browser disappears. Every request also
   checks the expiry. End/sign-out revokes immediately. Tabs in the same browser
   share a session; a reset in one tab invalidates the other tabs' old data.
6. Worker startup errors/crashes remove that session and return its capacity.
   Process restart destroys all sessions. The UI process is supervised: its exit
   stops the gateway so Docker's restart policy can recover the whole service.

Do not enter personal data or real secrets. Unsupported writes receive a clear
`DEMO_RESTRICTED` response. Account authentication/security enrollment, live
terminals/WebSockets, API/MCP execution, arbitrary image fetching, and unreviewed
endpoints cannot pass the gateway policy. Sample API keys are inert fixture
values, not credentials accepted by the gateway. Connection callbacks stay
on this origin. Jobs return simulated output; commands are never executed.
Displayed integrations and health are fixture data, never provider connections
or a report of the demo host's health.

## Hosting and security boundary

```text
Browser -- HTTPS try.towbar.dev:443 --> Caddy (edge network + sandbox network)
                                           |
                                  demo gateway :8080
                                  /            \
                       Next UI :4021       visitor workers (loopback)
```

Only Caddy publishes host ports. The gateway and Next port are not published;
Next and fixture workers listen on loopback inside the demo container. The
sandbox network is internal with Docker's `isolated` gateway mode: it has no
external route or host bridge address. External DNS resolution is disabled for
the demo container. Caddy has external access for ACME; its admin endpoint is off
and it proxies only to the fixed demo gateway, never visitor-supplied hosts.
See [Docker's isolated gateway mode](https://docs.docker.com/engine/network/port-publishing/#gateway-modes).

The demo is non-root, read-only, drops all capabilities, has no-new-privileges,
a bounded `/tmp`, 1 GiB memory, 1.5 CPUs, and 128 PIDs. Workers inherit an empty
environment and have V8 heap limits (64 MiB old / 16 MiB young). The UI receives
only four non-secret runtime variables. The image contains the dashboard and a
bundled fixture; no production API/worker process or deployment executor runs.
Do not add host configuration, host network, secrets, Docker socket, or another
network to this service. Do not run it on the Towbar production host.

Requests have a 16 KiB body/header limit, 4 KiB URL limit, origin/Host checks,
no cross-origin credentials, and a method/path allowlist. The proxy discards
visitor auth/cookies/forwarding headers before reaching fixtures or Next.
Responses are private/no-store; CSP restricts automatic browser connections to
this origin and blocks framing. Third-party telemetry is unconfigured. Caddy's
access log is off; do not enable raw cookie/body logging. Network limiter keys
are salted hashes discarded after inactivity; visitor data is in memory only.

The gateway uses the socket peer for network limits and ignores client-supplied
address headers. In this stack, that peer is Caddy at `172.30.44.2`, so visitors
share one network bucket. Direct IPv6 peers share a /64 rate bucket. Keep DNS in
DNS-only mode; review the network limit before placing another edge in front.

Default limits are 4 active/starting workers, 60 starts globally per ten
minutes, 12 starts per network per ten minutes, 360 API requests/session/minute,
1,800 requests/network/minute, 6,000 requests globally/minute, 100 state-changing
requests per session, 48 in-flight fixture requests and 8 streams per session, and
256 gateway connections. Date/time helper POSTs consume the API rate budget but do not consume the
state-change budget. Full capacity returns 503; rate limits return 429 with Retry-After.
These are bounded abuse controls, not a distributed denial-of-service defense.
The four-session cap leaves memory for the UI, Caddy, Docker, and the host on a
2 GiB VM. Measure resident memory and startup latency on the host before raising it.

## Local validation

Requires Node 26+, the repository's pinned pnpm, and Docker Engine 28+ with
Compose v2 and isolated bridge gateway support. Docker Desktop can run the
local architecture build; the publishing workflow builds and tests Linux arm64
on a native ARM runner.

```bash
pnpm install --frozen-lockfile
pnpm exec turbo run build --filter='towbar-web-app^...'
pnpm --filter towbar-web-app test
pnpm --filter towbar-web-app typecheck
pnpm --filter towbar-web-app lint
docker build --target demo --tag towbar-demo:test --file apps/towbar-web-app/Dockerfile .
bash tools/test-public-demo.sh
```

The container smoke boots the actual Caddy stack on loopback port 4880, visits
current UI routes, creates two sessions, verifies independent changes, deploys
synthetically, reveals/edits sample secrets, denies live terminal/auth actions, resets/revokes, and
restarts the service to verify old-cookie invalidation. It probes internet,
metadata, DNS, and host-bridge access from the runtime container, then removes
its test containers/networks/volumes. Do not run it beside another copy of this
stack using `172.30.44.0/29`. The unit suite separately tests time expiry and
open-stream termination, capacity races, origin checks, malformed/large bodies,
header spoofing, crash recovery, and auth-header stripping.

To leave the demo running for browser review after the smoke has cleaned up:

```bash
TOWBAR_DEMO_IMAGE=towbar-demo:test \
DEMO_ORIGIN=http://localhost:4880 \
DEMO_SITE_ADDRESS=http://localhost:80 \
DEMO_HTTP_BIND=127.0.0.1:4880 \
DEMO_HTTPS_BIND=127.0.0.1:4881 \
docker compose --project-name towbar-demo-review -f infra/demo/compose.yml up -d --wait
```

Open `http://localhost:4880/demo`. Start a demo, then open **Services → Example
Website → Deploy** to review progress. The standard configuration uses the real
ten-minute expiry and four-session capacity. Stop the preview with:

```bash
TOWBAR_DEMO_IMAGE=towbar-demo:test docker compose --project-name towbar-demo-review -f infra/demo/compose.yml down --volumes
```

## First public activation

1. Merge this PR through normal review and include it in the next release.
   Do not change the ordinary Towbar image: its Dockerfile still defaults to
   `runner`, and `/demo` is unavailable in a normal build.
2. Create the GitHub environment `public-demo`, restrict it to main, and apply
   the desired reviewer protection. Run **Publish public demo image** on main
   with that released tag. It resolves a non-draft, non-prerelease main-branch
   commit, builds `--target demo`, runs the container smoke, and pushes the
   tested arm64 image. Copy the immutable `TOWBAR_DEMO_IMAGE=...@sha256:...`
   output. Make `ghcr.io/avgeek-oss/towbar-demo` publicly readable (or configure
   a read-only registry login on the host). No SSH/cloud secrets are required
   by this publishing workflow.
3. Provision a **dedicated arm64 Ubuntu 24.04+ host**, initially 2 vCPU, 2 GiB
   RAM, and 20 GiB disk. Install Docker Engine 28+ / Compose v2, Node 26+, Git,
   curl, and util-linux (`flock`). Reserve `172.30.44.0/29` for this stack; if it
   collides, change the subnet, both static addresses, and smoke
   host probe together in a reviewed change. Do not attach a cloud instance
   role or give the host routes/credentials to production services.
4. Allow inbound TCP 80/443 from the internet and SSH only from operator
   addresses in the cloud firewall. Leave 4021/8080 closed. Host/Caddy outbound
   DNS and HTTPS are needed for image pulls and ACME; the demo's sandbox stays
   isolated. UDP 443 is optional and is not published by this stack.
5. Create a DNS-only A record `try.towbar.dev` → this host's public IPv4 with
   TTL 300. Remove stale AAAA records; this stack publishes IPv4 ports only.
   Check CAA permits Caddy's configured ACME issuer if the zone uses CAA.
   Verify public resolution and that no existing service occupies 80/443.
6. Clone the reviewed release onto that host and activate using the digest:

   ```bash
   git clone --branch v2.X.Y --depth 1 https://github.com/avgeek-oss/towbar.git /opt/towbar-demo
   cd /opt/towbar-demo
   bash tools/deploy-public-demo.sh ghcr.io/avgeek-oss/towbar-demo@sha256:REPLACE_WITH_64_HEX_DIGEST
   ```

   Replace `v2.X.Y` with the released tag containing this feature. Run as the
   dedicated operator with Docker access. The script locks concurrent updates,
   pulls the digest, starts Compose, waits for HTTPS, runs the public smoke,
   and atomically saves `infra/demo/.env` only on success. A failed first
   activation stops the new stack; a failed update restores the previous image.

7. Run `node tools/demo-smoke.mjs https://try.towbar.dev` from outside the host.
   In two separate browser profiles, verify independent data, countdown,
   simulated deployment progress, reset, sign-out, expiry after ten minutes,
   and narrow-screen navigation. Check the certificate and Secure cookie in
   browser tools, and confirm only 80/443 are internet-accessible. Then link the
   public demo from the website/release announcement.

The concrete external prerequisites are a selected dedicated host/public IP,
DNS/CAA control, a reviewed released tag, the GitHub environment, and a readable
published image digest. This task neither selects a production host nor changes
DNS. A runbook and a local green smoke are not evidence of public activation.

## Updates, rollback, and operations

Checkout the new reviewed release on the dedicated host, run the publishing
workflow for that tag, then run the same deploy script with its digest. Sessions
are intentionally lost on every deployment; the dashboard returns to the start
screen. Do not scale replicas: sessions are local to one gateway. Scaling
requires session routing or a different state model.

For an explicit rollback, read the old digest from `infra/demo/.env.previous`
and pass it to `tools/deploy-public-demo.sh`. Keep the matching prior checkout
if Compose or gateway configuration also changed. The script's automatic image
rollback assumes the current Compose file remains compatible.

```bash
docker compose --env-file infra/demo/.env -f infra/demo/compose.yml ps
docker compose --env-file infra/demo/.env -f infra/demo/compose.yml logs --tail 100
docker stats --no-stream
curl --fail https://try.towbar.dev/health
```

Monitor HTTPS `/health`, container restarts/OOMs, memory, and disk externally.
A 503 on start can mean occupied capacity; a 502/503 on all routes warrants
checking containers and logs. Restart the demo service to discard every
session if needed. To disable the demo, `docker compose --env-file
infra/demo/.env -f infra/demo/compose.yml down` and remove its DNS record.
Only Caddy certificate/config volumes persist; no visitor backup/restore or
cron reset job is needed. Keep Docker security patches and certificate storage
maintained. Domain TLS issuance and real-host capacity must be verified at
activation; local tests cannot establish either.

## Shared showcase data and action coverage

The local fixture and public workers use the same seed: 17 services (18 environment
instances), all eight managed datastore engines (11 instances), four repositories,
and eight servers. All server names show region/purpose; seven have simulated Scout charts and the
Amsterdam server demonstrates agent setup. Provider identities use
Towbar's supported AWS, GCP, Azure, Oracle, Hetzner, DigitalOcean, Linode, and
Alibaba types. Datastore images, ports, data paths, and backup engine versions
come from `managedResourceCompatibility`. Service examples cover Dockerfile,
static, image, Railpack, Nixpacks, buildpack, and Compose deployment modes,
previews, build servers, rollout strategies, volumes, jobs, hooks, and notifications.
Branded image services use the existing image logo catalog; site favicons are
bundled locally so no third-party requests are needed in the demo.
API Keys includes an inert ChatGPT MCP connection with the bundled OpenAI logo,
client identity, recent activity, and a 30-day expiry. Its revocation is local to
the visitor; OAuth authorization, token issuance, and MCP execution stay blocked.

| Interaction                                                                | Demo behavior                                                                 |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Reveal/edit service, datastore, or shared secrets                          | Fake values in the visitor's worker; revision checks, reset, and expiry apply |
| SSH key creation/reveal/selection, credential verification, host trust     | In-memory fixture keys and simulated verification; no SSH contact             |
| Server add/edit/remove, prepare, checks, monitoring                        | Mutates sample server records and simulated health                            |
| Deploy, cancel, retry, runtime start/stop/restart, logs                    | Simulated states, operations, and logs                                        |
| Scheduled jobs                                                             | Only a configured sample job; returns fixture output without execution        |
| Backups, restore, cleanup/cancel                                           | Sample backup metadata and a simulated restore timeline                       |
| Preview deploy/delete, vulnerability rescan                                | Sample records and states                                                     |
| Auto-deploy, preferences, alert rule CRUD                                  | Updates the visitor's sample configuration                                    |
| Notification destination edit/test                                         | Saves sample destinations and returns a simulated result; never sends         |
| Source discovery/connect and new source environment changes                | Fixture repositories and manifests; no Git fetch                              |
| GitHub connection flow                                                     | Same-origin fixture callback; no real OAuth grant                             |
| Team/member/invitation and sample API key management                       | In-memory records and inert sample keys; no email or gateway authentication   |
| Account sign-in, passkey/2FA enrollment, live terminals, API/MCP execution | Remain unavailable; no fixture-only shortcut changes gateway authentication   |
| Unknown routes or arbitrary image proxy requests                           | Rejected by the explicit gateway allowlist                                    |

Existing seeded repository environment mappings are read-only; new repository
connections support the fixture's environment add/edit/disconnect workflow.
The focused tests exercise catalog consistency, sample secret revision handling,
visitor isolation, reset/expiry, and representative newly enabled actions.
