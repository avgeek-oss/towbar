---
title: "Preview environments"
description: "Deploy eligible pull requests to isolated environments with stable URLs and separate secrets."
---

Preview environments let you review a service before merging a pull request. Each eligible service and pull request receives a stable URL. Production and preview releases have separate histories and secret environments.

<div className="towbar-doc-screenshot">
  <div className="towbar-product-light">
    <img src="/assets/release-v2/previews-light.jpg" alt="Preview environments show their URL, commit, expiry, and cleanup status." width="3200" height="1800" loading="lazy" />
  </div>
  <div className="towbar-product-dark">
    <img src="/assets/release-v2/previews-dark.jpg" alt="Preview environments show their URL, commit, expiry, and cleanup status." width="3200" height="1800" loading="lazy" />
  </div>
  <p>Preview environments show their URL, commit, expiry, and cleanup status.</p>
</div>

## Enable previews

Enable previews for an environment and opt each service in. Previews support GitHub pull requests and GitLab merge requests from the same repository. The service needs a public domain and TLS configuration; datastores are not cloned.

<CodeGroup>

```yaml title="towbar.yml"
version: 2
environments:
  staging:
    previews:
      enabled: true
```

```yaml title=".towbar/services/web.service.yml"
id: web
name: Web
deployment:
  type: dockerfile
  context: .
  dockerfile: Dockerfile
container:
  port: 3000
health:
  path: /health
domains:
  primary: staging.example.com
tls:
  mode: direct
preview:
  enabled: true
  domain: preview.example.com
  ttlHours: 72
environments:
  staging:
    server: 192.0.2.11
```

</CodeGroup>

Map `staging` to the target branch in **Repository → Environments**, register and prepare the server, then sync. Save isolated preview secrets before opening a pull request. Preview instances have separate release histories and isolated Towbar-managed secret values.

## Set up DNS

The generated hostname includes the Service ID, pull request number, and a stable
Repository/PR hash, for example
`hello-towbar-pr-42-a1b2c3d4.preview.example.com`. With
`tls.mode: cloudflare-dns`, Towbar creates and removes the exact DNS
record, inheriting the Service's `tls.proxied` setting (proxied by default). With `tls.mode: direct`, route the Preview base domain to the target
server yourself, normally through wildcard DNS. If Cloudflare proxies a nested
Preview wildcard, confirm that the zone's certificate covers that hostname;
DNS wildcard support does not by itself extend Universal SSL certificate
coverage to every nested level.

## Control concurrency and cleanup

Configure `buildConcurrency` and `previewBuildConcurrency` under **Server →
Settings**. Preview concurrency defaults to `1`, cannot exceed total build
concurrency, and is capped at `4`. Preview builds have lower queue priority
than production, Datastore, cleanup, and server operations. A newer PR commit supersedes only
queued work for that Service and PR. A failed build leaves the last healthy Preview
live. Merging or closing the pull request, retargeting it away from
the target environment's branch mapping, disabling Preview in the next successful Repository sync,
manually deleting it in Towbar, or reaching `ttlHours` queues targeted
container, image, route, and DNS cleanup; persistent volumes and Datastores are
never removed. Reopening an eligible pull request recreates its Preview.

## Pull request eligibility

Towbar reconciles `opened`, `reopened`, `synchronize`, `edited`, and `closed`
webhooks against the pull request's current GitHub state. GitLab merge-request hooks use the same branch, identity, and cleanup rules. This makes duplicate,
delayed, and out-of-order deliveries safe and keeps branch renames under the
same PR identity. Pull requests from forks and pull requests targeting another
base branch are not deployed. When a Service configures `autoDeploy.inputs`,
Preview admission uses those same expanded path patterns against the pull
request's complete changed-file list. An unrelated pull request does not create
a Preview, and reverting all matching changes cleans up an existing Preview.
An incomplete GitHub changed-file response remains eligible rather than risking
a false skip. Services using plain `autoDeploy: true` remain commit-sensitive and
Preview every eligible pull request. A successful `Sync now` also reconciles
open eligible pull requests and existing Preview environments, so enabling
Preview after a PR opens or recovering a missed webhook does not require a new
commit.

## GitHub status

GitHub groups preview deployments under one environment per Service, named
`Service name · Preview`. The PR number appears in the deployment description.
Each preview keeps its own URL and status; deploying one PR does not deactivate
another PR's preview. Older environments with PR numbers in their names remain
in GitHub until you remove them there.

Towbar also maintains one comment per Repository and pull request with every Service's
build status, Preview URL, and deployment details link. A hidden stable marker
lets Towbar update the same GitHub comment instead of posting a new comment for
each state change.

Temporary failures delivering GitHub statuses or comments are retried automatically in the background. Towbar publishes the latest Preview state, respects GitHub rate limits, and reuses existing deployments and comments. Reporting delays do not restart or stop a Preview. Delivery errors remain available through the GitHub integration API for diagnostics.

## GitLab reporting

GitLab previews publish a commit status with the preview URL and update one merge-request comment. A reporting delay does not change the running preview. Inspect provider access and webhook delivery if the status is missing.

## Separate secrets and trust

Treat Preview pull requests as executable deployment input. Use separate,
least-privilege Preview values with disposable or non-production
credentials. The connected environment controls the target server and Preview
base domain; the pull request does not move its Datastores. Save separate Preview
values in Towbar. Shared-secret references and external providers need their own
non-production values or scope.

## Verify a preview

1. Create a same-repository pull request against the preview-enabled environment's mapped branch.
2. Change a file included by the service's deployment inputs.
3. Open the preview in Towbar and wait for deployment to succeed.
4. Open its URL and verify the expected change.
5. Close the pull request and confirm cleanup completes.

If the preview is skipped, check branch eligibility and input patterns. If it builds but the URL fails, check [DNS and TLS](/docs/domains-tls). See [Secrets](/docs/secrets) for preview values and references.
