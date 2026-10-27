---
title: "Local installation"
description: "Install the Towbar control plane with loopback access."
---

## Before you begin

Use an Ubuntu or Debian host with persistent storage and outbound HTTPS access. Open the browser on that host, or forward its loopback ports through SSH.

Existing Docker installations need Compose v2; otherwise the installer installs Docker from its official APT repository.

## Run the installer

Review and run the release installer on the control-plane host:

```bash
curl -fsSL https://github.com/avgeek-oss/towbar/releases/latest/download/install.sh | sudo bash
```

Choose `http://localhost:4021` for the dashboard. The API uses `http://localhost:4020`. Both bind only to `127.0.0.1`.

The installer verifies the CLI checksum, installs `/usr/local/bin/towbar`, and verifies release assets. It pulls release images, applies database and Temporal schemas, and checks service health. Unique installation secrets are generated in `/etc/towbar/config.yml` with root ownership and mode `600`.

External REST, MCP, API-key management, and public provider webhooks require the [public HTTPS installation](/docs/self-hosting/installation/public). Custom ports, paths, fragments, HTTPS localhost, and non-HTTPS remote origins are rejected.

For a remote host, keep the services on loopback and forward the browser ports:

```bash
ssh -L 4021:127.0.0.1:4021 -L 4020:127.0.0.1:4020 operator@192.0.2.10
```

Then open `http://localhost:4021` on your computer.

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
