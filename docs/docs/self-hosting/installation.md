---
title: "Install Towbar"
description: "Install the control plane, create an Admin account and verify service health."
---

Towbar runs its dashboard, API, worker, PostgreSQL and Temporal in Docker Compose. Register deployment servers after installation.

## Before you begin

Use an Ubuntu or Debian host with persistent storage and outbound HTTPS access. Existing Docker installations need Compose v2; otherwise the installer installs Docker from its official APT repository.

For public access, point DNS A records for both the dashboard and API hostnames at the host and open inbound ports 80 and 443. Towbar cannot configure your DNS or firewall.

## Choose the installation URL

The installer accepts either:

- `http://localhost:4021` for on-host dashboard access, with the API on `http://localhost:4020`.
- Two public HTTPS origins, such as `https://towbar.example.com` for the dashboard and `https://towbar-api.example.com` for the API and MCP.

Custom ports, paths, fragments, HTTPS localhost and non-HTTPS remote URLs are rejected. Loopback mode disables external REST, MCP and API-key management. Public automation and provider webhooks require HTTPS.

## Install the control plane

Review and run the installer:

```bash
curl -fsSL https://github.com/avgeek-oss/towbar/releases/latest/download/install.sh | sudo bash
```

The installer verifies the CLI checksum and places it at `/usr/local/bin/towbar`. The CLI verifies the validated release, source archive and image manifest, then:

1. Installs required host packages and Docker if absent.
2. Downloads the release into `/opt/towbar/releases` and generates database, encryption and signing secrets.
3. Pulls the API, worker and dashboard images from GHCR by immutable digest.
4. Applies database and Temporal schemas, starts services and checks health.
5. For public access, obtains a Let's Encrypt certificate and verifies HTTPS recovery after a gateway restart.

Existing Docker installations remain managed by the host package manager. Optional integrations stay disabled until configured. See the [CLI guide](/docs/self-hosting/cli/install-upgrade) for version selection and upgrades.

Run `sudo towbar logs api` and copy the line labelled `Towbar installation setup secret`. Open the dashboard and enter that secret, the team name, your name, email and password. The first successful submission creates the initial team and Admin account, then closes setup. Configure SMTP for invitations and password recovery. See [Team access](/docs/self-hosting/team-access) and [Account recovery](/docs/self-hosting/account-recovery).

## Configure the installation

Configuration lives at `/etc/towbar/config.yml`, owned by `root:root` with mode `600`. It persists across upgrades.

```bash
sudo nano "$(towbar config path)"
sudo towbar config validate
sudo towbar restart
```

Validation checks Compose, API, worker, integrations, notifications and Caddy. `restart` reuses installed images and replaces services only after preflight checks pass. If validation or service startup fails, run `sudo towbar doctor`.

For public access, `installation.appUrl` sets the dashboard origin and `installation.apiBaseUrl` sets the API, MCP, webhook, and terminal transport origin. Caddy redirects HTTP to HTTPS and renews both certificates automatically. Certificate and ACME data persist in Docker volumes. Local mode binds only `127.0.0.1:4021` and `127.0.0.1:4020`.

If public setup fails, fix the reported DNS, port or certificate issue and retry. The installer removes the incomplete stack and releases ports 80 and 443 without enabling an HTTP fallback. It preserves secrets, releases, database data and ACME state. A retry can use different valid hostnames without replacing secrets.

Use the [runtime configuration reference](/docs/self-hosting/environment-variables) for integrations and [Configuration and restart](/docs/self-hosting/cli/configuration) for command details.

## Verify the installation

```bash
sudo towbar status
sudo towbar doctor
sudo towbar version
```

In **Manage → System health**, confirm that the API, database, Temporal and worker are healthy. GitHub may remain unconfigured during setup.

The `migrate`, `temporal-schema` and `temporal-namespace` jobs should exit successfully. API, worker, web app, PostgreSQL and Temporal should keep running. For startup errors:

```bash
sudo towbar logs migrate temporal-schema temporal temporal-namespace api worker
```

Repeated startup preserves workflow state. Do not delete PostgreSQL volumes to repair startup. Temporal APIs remain on the private network; its operator UI binds to loopback and requires an SSH tunnel. It has no Towbar login protection and must not be exposed publicly.

## Continue setup

Connect [GitHub](/docs/integrations/github), prepare a [server](/docs/servers), then follow [Your first deployment](/docs/getting-started). Read [Upgrades and recovery](/docs/self-hosting/upgrades) before changing versions.
