---
title: "GitHub"
description: "Configure a GitHub App in Towbar's YAML configuration, install it, and connect repositories."
icon: "/assets/integration-logos/github.svg"
---

import { Screenshot } from "/snippets/oss/screenshot.jsx";

<img className="towbar-doc-brand-logo" src="/assets/integration-logos/github.svg" alt="GitHub logo" aria-hidden="true" />

Towbar configures one GitHub App per Towbar installation and can connect it to multiple GitHub accounts. The App identity and private key live in `/etc/towbar/config.yml`. PostgreSQL stores connected installations and account metadata, never the App private key or an optional webhook secret.

## Create and configure the App

1. Open **Settings → Developer settings → GitHub Apps**, then choose **New GitHub App**. You can also open [GitHub's new App form](https://github.com/settings/apps/new) directly.

   ![Find GitHub Apps in Developer settings.](/assets/guides/github-app/open-developer-settings.png)

   ![Create a new GitHub App.](/assets/guides/github-app/create-github-app.png)

2. Give the App a unique name and set its **Homepage URL** to your Towbar origin.

   ![Set the GitHub App name and homepage URL.](/assets/guides/github-app/app-name-and-homepage.png)

3. Set **Setup URL** to `https://towbar.example.com/manage/integrations/github` and enable **Redirect on update**. Keep the webhook active, set **Webhook URL** to `https://towbar-api.example.com/v1/public/webhooks/github`, and leave SSL verification enabled. Use `installation.appUrl` for the Setup URL and `installation.apiBaseUrl` for the Webhook URL. The webhook secret is optional. If you set one in GitHub, enter the same value as `integrations.github.webhookSecret` in Towbar.

   | GitHub field       | Value                                                      |
   | ------------------ | ---------------------------------------------------------- |
   | Setup URL          | `https://towbar.example.com/manage/integrations/github`    |
   | Webhook URL        | `https://towbar-api.example.com/v1/public/webhooks/github` |
   | Redirect on update | Enabled                                                    |
   | SSL verification   | Enabled                                                    |

4. Open **Repository permissions**. Grant **Contents** read-only access; GitHub grants **Metadata** read-only access automatically. For Preview deployments, grant **Deployments** and **Pull requests** read and write access.

   ![Open the GitHub App repository permissions.](/assets/guides/github-app/repository-permissions.png)

   ![Grant Contents read-only access.](/assets/guides/github-app/contents-permission.png)

   ![Grant Deployments and Pull requests read and write access for Previews.](/assets/guides/github-app/preview-permissions.png)

5. Under **Subscribe to events**, select **Push** and **Pull request**. GitHub sends `installation` and `installation_repositories` events to GitHub Apps automatically; they do not appear as selectable events. [GitHub documents this behavior](https://docs.github.com/en/webhooks/webhook-events-and-payloads#installation).

   ![Subscribe the GitHub App to Pull request and Push events.](/assets/guides/github-app/subscribe-events.png)

6. Choose **Any account** to connect multiple organizations or personal accounts, or **Only on this account** if you only need the account that owns the App, then create it. On **General**, copy the App ID and slug for the Towbar configuration.

   ![Choose the GitHub App installation scope and create it.](/assets/guides/github-app/installation-scope.png)

7. On **General**, generate a private key. GitHub downloads a PEM file. Keep it outside the repository, encode it as a single-line Base64 value, and add the App details to `/etc/towbar/config.yml`:

   ![Generate a private key for the GitHub App.](/assets/guides/github-app/private-key.png)

```yaml title="/etc/towbar/config.yml"
integrations:
  github:
    enabled: true
    appId: "123456"
    appSlug: your-towbar-app
    privateKeyBase64: <base64-encoded-pem>
    apiUrl: https://api.github.com
```

Encode the PEM with `base64 < private-key.pem | tr -d '\n'`. If you set a webhook secret in GitHub, add `webhookSecret: <shared-webhook-secret>` under `integrations.github`. Towbar verifies GitHub webhook signatures when this value is configured. Without it, Towbar accepts unsigned webhook deliveries, so configure a secret when possible. Validate and restart Towbar. Startup fails if the key cannot be parsed or a required enabled field is missing.

## Install and use it

Open **Manage → Integrations → GitHub** and choose **Connect GitHub account**. Select only the accounts and repositories Towbar should manage. The connection widget is shown only because the runtime configuration is valid; no credential form is exposed.

<Screenshot light="/assets/release-v2/github-setup-light.jpg" dark="/assets/release-v2/github-setup-dark.jpg" alt="GitHub shows runtime App availability before an installation is connected." caption="The installation action appears after the GitHub App configuration values pass startup validation." width={3200} height={1800} />

After changing App permissions, approve the update in GitHub. Disconnecting removes Towbar's active installation access while leaving the runtime App identity unchanged. Use the connection status in Towbar and GitHub's webhook delivery history to diagnose access or delivery failures.

## Verify access

The connected accounts table shows each account, account type, connection status, and Preview reporting readiness. A healthy installation must remain active in GitHub and include Contents read access. Preview reporting also needs Pull requests and Deployments read and write access. Towbar never displays the App private key or webhook secret.

## Maintain the connection

Use **Review access** after adding App permissions or repositories. Use **Reconnect** when GitHub suspends or removes an installation. If webhooks stop arriving, inspect the App's recent deliveries in GitHub and confirm that the webhook URL uses `installation.apiBaseUrl`. Rotate the private key or configured webhook secret in `config.yml`, then validate and restart Towbar.

## Connect multiple GitHub accounts

One configured GitHub App can connect multiple organizations or personal accounts to the same Towbar workspace. To use it across accounts, choose **Any account** in the App's installation settings. This changes who can install the App; each installation still grants its own repository access.

In **Manage → Integrations → GitHub**, choose **Connect GitHub account** for each account. The connected accounts table shows each account's status, Preview reporting readiness, and access controls. **Review access** opens that account's installation settings in GitHub. Disconnecting an account stops sync and deployment access for its repositories; other accounts and running workloads remain unaffected. Reconnecting the same account preserves its existing source associations.

The **Add repository** dialog lists repositories from all connected accounts. Use **GitHub account** to narrow the list, and search using the full `owner/repository` name. If one account is unavailable, Towbar reports that account's failure while showing repositories from the others.

Organization names can change. Towbar refreshes the account's display name from GitHub and identifies it by its GitHub account ID, rather than treating the renamed organization as a new connection.

## Update a transferred or renamed repository

Before transferring repositories, open the GitHub integration page. Towbar verifies and records GitHub repository IDs for sources created before multiple-account support. Resolve any repository verification warnings while the original installation still has access.

After transferring or renaming a repository in GitHub:

1. Connect the destination account and grant its installation access to the repository.
2. Open the existing Repository in Towbar, then **Settings → GitHub connection → Change repository connection**.
3. Select the destination account and the repository's new location, then choose **Save connection**.
4. Sync the repository before its next deployment.

Towbar verifies that the destination has the same GitHub repository ID and can read every connected environment's branch. The change preserves the Source ID, environments, deployment history, domains, secrets, and settings, and does not start a deployment. Wait for active syncs and deployments to finish before saving. A different repository must be added separately.

If an older source's repository ID could not be verified before the transfer, Towbar needs access through its original connection to establish that identity. It does not infer identity from a matching repository name.
