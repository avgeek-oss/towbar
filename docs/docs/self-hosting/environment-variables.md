---
title: "Runtime configuration"
description: "Reference for Towbar's YAML configuration, including secrets, integrations, notifications, and worker settings."
---

Use this reference when configuring the Towbar installation. Workload secrets are described in [Secrets](/docs/secrets), and workload behavior belongs in the [deployment manifest](/docs/deployment-manifest).

The installer creates `/etc/towbar/config.yml` with root ownership and mode `600`. `towbar config path` prints that location without reading the file. Edit it with an editor such as `sudo nano "$(towbar config path)"`, validate it with `sudo towbar config validate`, and apply changes with `sudo towbar restart`. Editing YAML alone does not update running services.

Towbar does not provide a configuration editor. Before replacing a running container, `restart` validates the YAML and Compose model, then runs API, worker, integration, notification, and Caddy preflights against the installed release images. A failed preflight leaves the running services untouched and directs you to `sudo towbar doctor`.

```yaml title="/etc/towbar/config.yml"
version: 1
installation:
  mode: public
  appUrl: https://towbar.example.com
  apiBaseUrl: https://towbar-api.example.com
database:
  postgresPassword: "..."
  runtimePassword: "..."
security:
  credentialsKey: "..."
  internalHmacSecret: "..."
integrations:
  github:
    enabled: true
    appId: "12345"
    appSlug: towbar
    privateKeyBase64: "..."
```

Optional provider objects can be added under `integrations` and `notifications`. Keep identifiers and secrets quoted when they contain only digits or YAML-special characters. Unknown settings and duplicate YAML keys are rejected.

## Required installation secrets

| YAML setting                  | Purpose                                 |
| ----------------------------- | --------------------------------------- |
| `database.postgresPassword`   | PostgreSQL owner and migration password |
| `database.runtimePassword`    | Restricted API database password        |
| `security.credentialsKey`     | Encrypts stored secrets and credentials |
| `security.internalHmacSecret` | Signs API and worker internal requests  |

Generate the PostgreSQL passwords and HMAC secret independently with
`openssl rand -hex 32`. Hex output is URL-safe for the Compose database URLs.
`security.credentialsKey` must instead be a separate 32-byte Base64 value from
`openssl rand -base64 32 | tr -d '\n'`; Towbar rejects any other decoded key
length.

## Public origins

The web app reads the Towbar origin at runtime. One prebuilt dashboard image can
therefore serve localhost and public HTTPS installations.

| YAML setting              | Example                          |
| ------------------------- | -------------------------------- |
| `installation.appUrl`     | `https://towbar.example.com`     |
| `installation.apiBaseUrl` | `https://towbar-api.example.com` |

`installation.appUrl` is the dashboard origin. `installation.apiBaseUrl` is the
separate origin for REST, MCP, webhooks, streaming, terminal transport, and
credentialed dashboard requests. Both must use HTTPS in public mode. The API
domain is derived from `apiBaseUrl` for Caddy; the UI gateway domain is derived from `appUrl`; do not edit the generated
Compose environment file. Matching legacy `installation.gatewayDomain` values are removed during configuration migration. The API and dashboard images are upgraded together.
The local profile serves the dashboard at `http://localhost:4021` and the API
at `http://localhost:4020`, both bound to loopback. External REST, MCP, and
API-key management require a public HTTPS installation.

The public profile binds ports 80 and 443, obtains and renews a Let's Encrypt
certificate for each hostname, and persists Caddy's certificate state. The
installer selects the profile.

## Runtime integrations

Towbar integrations are configured in the root-owned YAML file. The dashboard never accepts or reveals provider credentials. An integration appears in the UI only after its `integrations.<provider>.enabled` setting is `true` and every required value is valid. The API validates all enabled integrations before it begins listening; a partial configuration fails startup instead of leaving a broken provider visible.

Set secret values directly. Towbar does not support external file references. Encode multiline values as Base64 where the YAML setting ends in `Base64`. Structured maps and lists are native YAML. Run `sudo towbar restart` after changing integration configuration.

### Source control

| Provider     | Required YAML settings                                                                                   | Optional settings                |
| ------------ | -------------------------------------------------------------------------------------------------------- | -------------------------------- |
| GitHub App   | `integrations.github.enabled`, `appId`, `appSlug`, `privateKeyBase64`                                    | `apiUrl`, `webhookSecret`        |
| GitLab OAuth | `integrations.gitlab.enabled`, `oauthClientId`, `oauthClientSecret`, `oauthRedirectUri`, `webhookSecret` | `baseUrl`, `allowPrivateNetwork` |

GitHub stores only the selected App installation and account metadata in PostgreSQL. GitLab stores only an encrypted, revocable OAuth grant and short-lived PKCE authorization attempts. App identity, OAuth client secrets, webhook secrets, and provider endpoints remain in the protected YAML file.

When `integrations.github.webhookSecret` is set, Towbar requires a valid signature on GitHub webhooks. If omitted, GitHub webhook delivery remains available without signature verification.

### Registries, storage, secrets, and platform services

| Provider             | Enable setting                    | Required values                                        |
| -------------------- | --------------------------------- | ------------------------------------------------------ |
| OCI registry         | `integrations.registry.enabled`   | `host`, `password`; `username` is optional             |
| AWS                  | `integrations.aws.enabled`        | `region`, `accessKeyId`, `secretAccessKey`             |
| S3 compatible        | `integrations.s3.enabled`         | `region`, `accessKeyId`, `secretAccessKey`             |
| Cloudflare R2        | `integrations.r2.enabled`         | `endpoint`, `region`, `accessKeyId`, `secretAccessKey` |
| Google Cloud Storage | `integrations.gcs.enabled`        | `projectId`, `serviceAccountJsonBase64`                |
| Infisical            | `integrations.infisical.enabled`  | `clientId`, `clientSecret`                             |
| Doppler              | `integrations.doppler.enabled`    | `token`                                                |
| Cloudflare           | `integrations.cloudflare.enabled` | `accountId`, `apiToken`                                |

Other supported fields include bucket, prefix, endpoint, addressing style, private-network access, CA certificate, zone, and image under the corresponding provider. Temporary AWS sessions are intentionally unsupported because they cannot be maintained safely as static installation configuration.

### Notifications

Set `notifications.enabled: true` and add provider credentials under `notifications.providers`. Manage Email, Slack, and Telegram destinations in the dashboard. Discord webhook credentials and webhook push endpoint URLs, headers, and signing secrets stay in YAML; their subscriptions are managed in the dashboard. Route IDs, Discord webhook IDs, and webhook endpoint IDs must be unique.

```yaml title="/etc/towbar/config.yml"
notifications:
  enabled: true
  providers:
    smtp:
      from: towbar@example.com
      host: smtp.example.com
      port: 587
      secure: false
      username: towbar
      password: "..."
    discord:
      - webhookId: "123456789012345678"
        webhookToken: "..."
    telegram:
      botToken: "123456:..."
    webhook:
      - id: operations
        label: Operations
        url: https://hooks.example.com/events
        headers:
          Authorization: "Bearer ..."
        signingSecret: "..."
```

The dashboard shows the active providers and routes without returning credentials. Notification events, delivery attempts, provider outcomes, and thread identifiers remain persisted for reliable retries and audit history.

## Image vulnerability scanning

Set `worker.vulnerabilityScanning.enabled: true` to make image scanning
available to Repositories. Each Service must then opt in explicitly in its deployment
manifest:

```yaml title=".towbar/services/hello-towbar.service.yml" highlight={2}
id: hello-towbar
vulnerabilityScanning: true
environments:
  production: {}
```

Towbar queues a scan of that Service's immutable image digest after each successful
production or Preview deployment. Changing only this Service policy does not force
a redeployment, and Datastores are not scanned. Towbar reuses one result per
workspace and image digest, stores only bounded normalized findings, and keeps
scan failures separate from deployment health. The deployment detail page
shows severity totals, actionable findings, scanner metadata, and stale or
failed states. Disabling the Service policy stops new scans without deleting prior
results.

`worker.vulnerabilityScanning.maxAgeHours` controls when completed results are
labelled stale and defaults to `168` hours. `worker.vulnerabilityScanning.trivyImage` configures the
worker-side scanner and must pin both a Trivy tag and image digest. The shipped
default is a reviewed multi-architecture pin. Restart Towbar after changing scanner configuration:

```bash
sudo towbar restart
```

See [Vulnerability scanning](/docs/vulnerability-scanning) for workspace findings, scan states, and rescanning.

## Account security

Initial setup atomically creates one team and Admin, then closes permanently. Email recovery, MFA and the local recovery command are documented in [Team access](/docs/self-hosting/team-access).

`security.passwordBreachCheck` defaults to `true`; explicitly setting `false` supports isolated installations without the password corpus service. `security.passwordVerifyConcurrency` defaults to `2` (range 1–8), and `security.passwordVerifyQueueLimit` defaults to `16` (range 1–100). Benchmark resource usage before raising these limits. Saturation returns a retryable busy response.

## Servers and worker capacity

Register IP addresses, SSH access, and concurrency under [Servers](/docs/servers). These settings do not belong in the manifest. Cloudflare and [AWS credentials](/docs/integrations/aws) are optional integrations configured in YAML.

| YAML setting                     | Default                    | Purpose                                                  |
| -------------------------------- | -------------------------- | -------------------------------------------------------- |
| `installation.mode`              | `local`                    | Selects the `local` or `public` gateway                  |
| `worker.maxConcurrentActivities` | `4`                        | Global worker activity capacity                          |
| `worker.appId`                   | `towbar-worker` in Compose | Manifest app identity for worker self-deployment cleanup |
| `installation.bindAddress`       | `127.0.0.1`                | Published Compose port binding                           |
| `installation.port`              | `4021`                     | Dashboard port on the host in local mode                 |
| `installation.apiPort`           | `4020`                     | API port on the host in local mode                       |
| `installation.temporalUiPort`    | `8233`                     | Temporal UI port on the host                             |
| `installation.networkName`       | `towbar-platform`          | Compose network name                                     |

Keep worker activity capacity above the largest server build-concurrency setting, leaving room for sync and maintenance. Restrict the Temporal UI to administrators.

## Installation and upgrades

Towbar installation and upgrades run on the control-plane host. See [Install Towbar](/docs/self-hosting/installation) for the installer and [Upgrades and recovery](/docs/self-hosting/upgrades) for the CLI upgrade process.

## API and MCP rate limits

`security.apiRateLimit.max` defaults to `60` requests and
`security.apiRateLimit.windowSeconds` defaults to `60` seconds. The API and
MCP share persistent per-key and per-IP limits. The per-IP limit uses the API's
connection peer, which is the bundled gateway for self-hosted installs. Set both
YAML values and restart after changes. See [API authentication and rate
limits](/docs/api/authentication) for bounds, response headers, and examples.

## Installation setup secret

Before creating the first administrator, copy `Towbar installation setup secret` from the API startup logs (`sudo towbar logs api`, or `docker compose logs api` for Compose installations). The setup form requires this secret. It is derived separately from the internal HMAC secret; do not paste the internal secret into the browser. The API prints it only until initial setup is complete. Existing teams continue to sign in normally after upgrading.
