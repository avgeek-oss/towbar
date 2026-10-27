---
title: "Your first deployment"
description: "Take a Dockerfile service from a GitHub repository to a verified deployment on your Ubuntu server."
---

import { Screenshot } from "/snippets/oss/screenshot.jsx";

Deploy the [example HTTP service](https://github.com/avgeek-oss/towbar/tree/main/examples) from GitHub to your server.

## Before you begin

You need an [installed Towbar](/docs/self-hosting/installation), an Admin account, a [connected GitHub App](/docs/integrations/github) and an [Ubuntu server](/docs/servers).

Replace example IPs and hostnames with your own values.

## 1. Create your service repository

Create a GitHub repository and copy `Dockerfile`, `.dockerignore`,
`package.json`, and the `src/` directory from the [starter application](https://github.com/avgeek-oss/towbar/tree/main/examples) into its root. Grant the connected
GitHub App access to your repository. The service needs no dependencies or secrets.
Run it locally with Node.js 24 or newer:

```sh
npm start
```

Open `http://localhost:3000` and check `http://localhost:3000/health`.

Create `towbar.yml` and `.towbar/services/hello-towbar.service.yml`, replacing the server IP and domain.
For a first deployment to production, use:

<CodeGroup>

```yaml title="towbar.yml" highlight={2-3}
version: 2
environments:
  production: {}
```

```yaml title=".towbar/services/hello-towbar.service.yml" highlight={4-18}
id: hello-towbar
name: Hello Towbar
deployment:
  type: dockerfile
  dockerfile: Dockerfile
  context: .
container:
  port: 3000
  resources:
    cpus: 0.5
    memory: 256m
health:
  path: /health
  timeoutSeconds: 60
domains:
  primary: hello.example.com
environments:
  production:
    server: 192.0.2.10
    tls:
      mode: direct
```

</CodeGroup>

Use the server IP registered in Towbar. Match the Dockerfile path, port, and health endpoint to your service. Point the domain at the target server and allow the traffic required by [Caddy and TLS](/docs/domains-tls).

Commit the files to your production branch. Deploy the first release manually before enabling automatic deployments.

## 2. Add and sync the Repository

In **Repositories → Add repository**, select the repository and map production to your branch. Wait for the initial sync.

Sync imports **Hello Towbar** into Services. Correct any reported manifest or server-reference errors and sync again. The service starts only after deployment.

<Screenshot light="/assets/release-v2/repositories-light.jpg" dark="/assets/release-v2/repositories-dark.jpg" alt="Repositories show their imported service and datastore inventories and latest sync time." caption="Repositories show their imported service and datastore inventories and latest sync time." width={3200} height={1800} />

## 3. Verify the server

Under **Servers → Settings → Configuration**, select or add an [SSH key](/docs/ssh-keys). Install its public key on the server, then save. Compare the discovered host fingerprint with the server console and trust it only if they match.

Choose **Prepare Server** and wait for **Ready**. Resolve any failed preparation step before deploying.

## 4. Save service secrets

Declare required keys in the service file's top-level `secrets` field and sync. Save their values under **Settings → Secrets**. Missing values block deployment, not sync. Use `{{globals.KEY}}` for a workspace value or `{{repo.KEY}}` for a repository value; shared values are not injected automatically.

Skip this step for Hello Towbar, which needs no secrets.

Unchanged fields preserve saved values. Saving secrets does not deploy. See [Secrets in Towbar](/docs/secrets/towbar) for access and rotation.

## 5. Deploy

Open the service and choose **Deploy**. Towbar fetches the commit, builds a candidate, checks health and promotes the release.

For failures, inspect the stage output and [troubleshooting guide](/docs/troubleshooting) before retrying.

<Screenshot light="/assets/release-v2/deployments-light.jpg" dark="/assets/release-v2/deployments-dark.jpg" alt="Filter deployment history by status, trigger, and workload." caption="Filter deployment history by status, trigger, and workload." width={3200} height={1800} />

## 6. Verify the result

Confirm all four conditions:

- The Repository sync succeeded at the intended commit.
- The target server is Ready.
- The deployment reached Succeeded.
- The configured HTTPS domain serves the expected service version.

For a service without a public domain, verify it through its intended private client instead.

## Next steps

Change the response in `server.mjs`, commit and deploy again. Reload the public page to verify the update.

Then add [automatic deployments](/docs/deployments#automatic-deployments), [previews](/docs/previews), [datastores](/docs/datastores) or [notifications](/docs/integrations/notifications).
