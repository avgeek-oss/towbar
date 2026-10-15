# Isolated deployment target

Run from the repository root:

```sh
node tools/e2e/target.mjs
```

The harness builds a disposable Linux target with SSH and its own Docker daemon.
It requires Docker support for privileged containers (Docker Desktop or Colima).
It does not mount the host Docker socket or reuse the host daemon's workload
containers and volumes. By default only SSH is published, on a random loopback port.

The smoke check connects as the non-root `deploy` user and compares daemon IDs
to verify isolation. It also checks executable paths required by the deployer.
The generated SSH key, container and anonymous volumes are removed on completion
or setup failure. The reusable `towbar-v2-e2e-target:local` image remains cached.

`startTestTarget()` returns the SSH port, private key path, `ssh(command)` and
`close()` for a lifecycle runner. Always call `close()` in `finally`.

The default target supports private app/resource deployment testing. Passing
`{ systemd: true }` starts real systemd services for SSH, Docker and Caddy. The
smoke check does not verify API admission, Temporal workflows, deployments,
backups or PR handling.

## Resource deployment lifecycle

```sh
pnpm --filter @workspace/towbar-deployer... build
node tools/e2e/resource-lifecycle.mjs
```

This runner calls the production `executeDeployment` implementation over SSH to
an Ubuntu target. It deploys two Redis instances with the same logical ID on
separate networks, writes distinct data, redeploys staging, and deliberately
fails a staging candidate's health check. Assertions check retained data in both
environments, recovery of staging's previous container, and candidate cleanup.
The target includes real Docker and Caddy binaries; systemd and public TLS setup
are not exercised.

The runner supplies resolved configuration/secrets and an in-memory release
commit callback. It verifies the deployer, not API admission, database release
transactions or Temporal delivery. Those need the subsequent lifecycle runner.

For database-backed execution, build the API and supply a dedicated PostgreSQL
URL whose database name ends in `_test`:

```sh
pnpm exec turbo run build --filter=towbar-api
TOWBAR_TEST_DATABASE_URL=postgres://user:password@localhost:5432/towbar_test node tools/e2e/resource-lifecycle.mjs
```

This mode runs migrations, creates an isolated workspace with production and
staging mappings, stores encrypted credentials and environment secrets, and
uses the production API services to resolve execution contexts and commit
releases. It verifies that current database releases match the running
containers and that the unhealthy candidate has no release. Test rows are
removed afterward; use a disposable test database.

The runner calls services directly. It does not exercise HTTP admission or
Temporal delivery, and the unsuccessful candidate remains at `checking_health`
until test cleanup because workflow failure handling is not part of this mode.

## Temporal resource lifecycle

Start a dedicated local Temporal development server in a separate terminal:

```sh
temporal server start-dev --ip 127.0.0.1 --port 17239 --headless
```

Build the API, deployer and worker, then run:

```sh
pnpm exec turbo run build --filter=towbar-api
pnpm exec turbo run build --filter=towbar-worker
TOWBAR_TEST_TEMPORAL_ADDRESS=127.0.0.1:17239 \
TOWBAR_TEST_DATABASE_URL=postgres://user:password@localhost:5432/towbar_test \
node tools/e2e/resource-lifecycle.mjs
```

This mode serves the production internal API on a random loopback port and runs
production deployment activities in a unique Temporal namespace. Deployment
requests use the real admission service and signal the server coordinator, which
starts `runDeploymentWorkflow`, including signed HTTP requests, secret
resolution, release commits, and failure recovery. Assertions require three
completed workflows, one failed workflow, matching database/runtime releases,
and successful replay of all four histories. The worker, API listener, test rows
and Docker target are closed afterward. Stop the dedicated Temporal server when
finished; its workflow histories remain available until then.

Source sync snapshots, instances, and server readiness are seeded in PostgreSQL.
The runner verifies admission, idempotent retries, server coordinator delivery,
and execution. It does not exercise browser/API authentication for deployment
requests or GitHub source synchronization.

## Non-root vulnerability scanning

```sh
pnpm exec turbo run build --filter=towbar-worker
node tools/e2e/trivy-lifecycle.mjs
```

This runner executes the production Trivy script over SSH as the non-root
`deploy` user on the isolated Linux target. It downloads the pinned scanner and
its vulnerability database, scans an Alpine image, and checks the parsed result.
A negative control mounts the private parent directory instead of the readable
archive and must fail with a Linux permission error. Successful scans, permission
failures and missing-image failures must all remove temporary archives.

The scanner keeps the production restrictions, including dropped capabilities,
a read-only root filesystem and an offline image scan. The cache lives in the
nested Docker daemon and is removed with the target. Network access to the image
registry and vulnerability database is required. This verifies scanner execution
and cleanup; scheduling and presentation of findings need separate coverage.

## Application build lifecycle

```sh
pnpm --filter @workspace/towbar-deployer... build
node tools/e2e/app-lifecycle.mjs
```

This runner builds a small HTTP app from two controlled source archives. The
production deployer fetches the exact requested commit, extracts and transfers
the archive, mounts a BuildKit secret, builds the image, starts a container with
runtime values, and checks health over HTTP. Three instances share the same
logical app ID but have separate production, staging and preview runtime IDs.
The runner updates staging to the second revision and fails a preview candidate,
checking that the other instances and the previous healthy preview stay intact.

Only the GitHub archive response and release-commit callback are simulated.
Unexpected fetches fail. Docker builds, SSH, health checks and runtime recovery
are real. Public domains/TLS, API admission and PR eligibility/reconciliation are
outside this runner. It does not prove complete PR lifecycle support.

For persistent files, run the same lifecycle with:

```sh
TOWBAR_TEST_STORAGE=1 node tools/e2e/app-lifecycle.mjs
```

This adds an uploads volume and runs the image as UID 1000. The checks write
separate production, staging and preview files, then verify their contents and
mount identities after redeployment, a failed candidate and container restart.

## Preview cleanup and routing

```sh
pnpm --filter @workspace/towbar-deployer... build
node tools/e2e/preview-cleanup-lifecycle.mjs
```

This runner uses the systemd target and calls production preview cleanup over
SSH. It creates separate production and preview containers, an orphan preview
candidate without a release record, and Caddy HTTP routes. Cleanup must remove
both preview containers and their images, remove the preview route, reload the
real Caddy service, and keep production responding. A second cleanup must also
succeed. The target and its volumes are removed afterward.

This verifies remote cleanup and service reload, including runtime-label orphan
discovery. It seeds containers and local HTTP routes; it does not exercise PR
webhooks, API cleanup admission, external DNS, or public certificate issuance.

For persistent app admission and worker execution, start the dedicated Temporal
server described above, build the API and worker, and run:

```sh
TOWBAR_TEST_TEMPORAL_ADDRESS=127.0.0.1:17239 \
TOWBAR_TEST_DATABASE_URL=postgres://user:password@localhost:5432/towbar_test \
node tools/e2e/app-lifecycle.mjs
```

This mode exercises production/staging app admission, idempotent requests,
server coordinator delivery, signed internal API calls, encrypted build/runtime
secret resolution, Docker builds and database release commits. It updates
staging and rejects an unhealthy staging candidate while keeping production
and the prior staging release available. All four workflow histories are replayed.

Only GitHub token/archive responses are simulated; unexpected network requests
are rejected, except for the test's own internal API listener. Source snapshots
and server readiness are seeded. PR reconciliation, authentication, public TLS
and server preparation remain outside this mode. Without a Temporal address,
the original deployer-only production/staging/preview runner remains available.

## Local HTTPS routing

```sh
pnpm --filter @workspace/towbar-deployer... build
node tools/e2e/https-target.mjs
TOWBAR_TEST_HTTPS=1 node tools/e2e/app-lifecycle.mjs
```

HTTPS mode requires an available loopback port 443 and DNS resolution for
`*.127.0.0.1.nip.io`. It starts the systemd target with real Caddy and a local
certificate authority. The runner adds that authority to its Node process and
sets `CURL_CA_BUNDLE` for its origin checks, restoring both on cleanup. It does
not modify the host trust store or disable certificate validation. The target
and certificate file are removed afterward.

The smoke check exercises the production origin and hostname health checks.
The app runner additionally verifies real HTTPS responses for production,
staging and preview after a staging update and an unhealthy preview candidate.
Only the GitHub token/archive responses and release callback are simulated in
this mode. These checks cover local TLS routing, not public ACME issuance or
PR event reconciliation. `TOWBAR_TEST_HTTPS=1` can also be combined with the
Temporal mode above. That combination passed with production/staging routes,
three successful deployments, one intentional unhealthy candidate failure,
database release assertions and replay of all four workflow histories.

## PR reconciliation lifecycle

Build the API and worker from the current checkout, start the dedicated Temporal
server above, then run:

```sh
pnpm exec turbo run build --filter=towbar-api
pnpm exec turbo run build --filter=towbar-worker
TOWBAR_TEST_PR=1 TOWBAR_TEST_HTTPS=1 \
TOWBAR_TEST_TEMPORAL_ADDRESS=127.0.0.1:17239 \
TOWBAR_TEST_DATABASE_URL=postgres://user:password@localhost:5432/towbar_test \
node tools/e2e/app-lifecycle.mjs
```

After the persistent app lifecycle, this mode calls the production PR
reconciliation service against controlled GitHub PR, immutable tree/blob and
archive responses. It deploys two PR revisions through real admission, Temporal,
signed internal API calls, Docker and Caddy HTTPS. Duplicate reconciliation must
reuse the deployment. Closing the PR must remove its runtime containers, images
and Caddy route; repeated closure must be harmless. Production and staging must
keep serving their own revisions, and staging configuration and secret
declarations must remain unchanged. Preview builds use isolated preview secrets.
All six deployment workflow histories are replayed.

GitHub responses are simulated, including deployment reporting. Source snapshots,
server readiness and initial secrets are seeded. The runner invokes the
reconciliation service directly; webhook authentication and the event-dispatch
workflow are outside this test. Local TLS uses the process-scoped test CA, not
public ACME. Rebuild both services before running to avoid testing stale compiled
worker/API contracts.

## Redis backup and restore lifecycle

```sh
pnpm --filter @workspace/towbar-deployer build
TOWBAR_TEST_BACKUP=1 node tools/e2e/resource-lifecycle.mjs
```

Run this mode without database/Temporal environment variables. After deploying
independent production/staging Redis instances, it exports a real RDB backup over
SSH, stores its bytes and metadata in an in-memory storage adapter, changes the
staging value, and restores the backup through `executeResourceOperation`.
A corrupted download must fail checksum validation without changing the running
database. The valid backup must pass import, candidate validation and promotion,
recover staging's saved value, retain the previous volume and leave production's
value unchanged. Runtime ownership and candidate-container cleanup are checked.

This exercises real Redis persistence, archive transfer, checksum validation,
remote import and promotion. The storage adapter replaces cloud object storage;
it does not prove cloud-provider transport, API admission or operation-result
persistence. The target and all its volumes are removed on completion.

## Independent OCI runtime configuration

After building the deployer, run `node tools/e2e/oci-runtime-lifecycle.mjs`.
It uses controlled immutable source archives and the production executor over
non-root SSH. Docker checks prove read-only and executable file modes, a UID 1000
image reading files transferred by a different host UID, command/entrypoint
overrides, hook-only secrets and failure cleanup, health on another port,
managed Redis configuration, failed replacement recovery and retained-file
rollback without repository access.

`node tools/e2e/independent-oci-lifecycle.mjs` additionally runs the five entities
in `examples/independent-oci` with real Linux ARM64 images. It prepares a
checksum-pinned histogram executable in its temporary source snapshot, supplies
random credentials through the existing secret bundles, and deploys in explicit
operator order on one private network. Source archive responses and release
callbacks are controlled; migrations, private DNS, Docker, HTTP readiness and
ClickHouse executable functions run for real. The target is always removed.
The fixture completes SigNoz first-run registration with a disposable account
and verifies OTLP HTTP after the collector receives its managed configuration.
This does not prove public ingress, API/Temporal delivery, or release compatibility.

## Managed centralized log collector

After building the deployer, run `node tools/e2e/log-collector-lifecycle.mjs`.
The required API verification group includes this check. It boots the disposable
Ubuntu/systemd target, installs through trusted non-root SSH, and verifies real
Docker source discovery, the pinned collector image, read-only host-log volume,
resource limits, ingestion, checkpoint-preserving update, and disable retaining
state. All containers, state, credentials, and the target are disposable.

The protocol endpoint is controlled inside the target so this lifecycle check
isolates installation from storage and authentication. The separate logging API
integration suite exercises the real PostgreSQL/ClickHouse path, authorization,
replay, retention, REST, and MCP. Neither check establishes production capacity
or a deployed public browser flow.
