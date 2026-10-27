---
title: "Public HTTPS installation"
description: "Install the Towbar control plane with public HTTPS origins."
---

## Before you begin

Point DNS A records for both `towbar.example.com` and `towbar-api.example.com` at the control-plane host. Open inbound ports 80 and 443. Towbar cannot configure your DNS or firewall.

Use an Ubuntu or Debian host with persistent storage and outbound HTTPS access. Existing Docker installations need Compose v2; otherwise the installer installs Docker from its official APT repository.

## Run the installer

Review and run the release installer on the control-plane host:

```bash
curl -fsSL https://github.com/avgeek-oss/towbar/releases/latest/download/install.sh | sudo bash
```

Choose `https://towbar.example.com` as the dashboard origin and `https://towbar-api.example.com` as the API origin. Replace both with hostnames you control. The installer suggests an API hostname and lets you change it.

The installer verifies the CLI checksum, installs `/usr/local/bin/towbar`, and verifies release assets. It pulls release images, applies database and Temporal schemas, and checks service health. Unique installation secrets are generated in `/etc/towbar/config.yml` with root ownership and mode `600`.

Caddy obtains a Let's Encrypt certificate for each hostname, redirects HTTP to HTTPS, and verifies gateway recovery. Certificate and ACME state persist in Docker volumes.

If setup fails, fix the reported DNS, port, or certificate issue and retry. Towbar removes the incomplete stack and releases ports 80 and 443 while preserving secrets, releases, database data, and ACME state. It never enables a public HTTP fallback.

## Create the first administrator

```bash
sudo towbar logs api
```

Copy the line labelled `Towbar installation setup secret`. Open the dashboard and enter it with the team name, your name, email, and password. The first successful submission creates the initial team and Admin account, then closes setup. Configure SMTP for invitations and email recovery; see [Team access](/docs/self-hosting/team-access).

## Verify the installation

```bash
sudo towbar status
sudo towbar doctor
sudo towbar version
```

In **Settings → System health**, confirm that the API, PostgreSQL, Temporal, and worker are healthy. GitHub may remain unconfigured. The `migrate`, `temporal-schema`, and `temporal-namespace` jobs should exit successfully; application services should keep running.

For startup failures, inspect the schema and application logs:

```bash
sudo towbar logs migrate temporal-schema temporal temporal-namespace api worker
```

Do not delete PostgreSQL volumes to repair startup. Follow [Troubleshooting](/docs/troubleshooting) for the failed stage.

## Continue setup

Review [Configuration](/docs/self-hosting/configuration), connect [GitHub](/docs/integrations/github) or [GitLab](/docs/integrations/gitlab), register a [server](/docs/servers/register), then follow [Your first deployment](/docs/getting-started). Set up [backups](/docs/self-hosting/backup) before changing versions.
