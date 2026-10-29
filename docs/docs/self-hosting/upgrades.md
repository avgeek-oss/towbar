---
title: "Upgrades and recovery"
description: "Plan a release upgrade, protect control-plane state, and recover Admin access."
---

Upgrade the API, worker, and dashboard together from a reviewed release. Before changing versions, read the [changelog](https://github.com/avgeek-oss/towbar/releases) for migration requirements.

## Prepare an upgrade

1. Pause automatic deployments and allow active operations to finish.
2. [Back up the control plane](/docs/self-hosting/backup), including every PostgreSQL database and the protected configuration file.
3. Run `sudo towbar version` and record the installed release.
4. Review the target release and its migration notes.
5. Run the CLI upgrade, inspect migration output, and verify System health before resuming deployments.

Upgrade to the latest published stable release:

```bash
sudo towbar upgrade
sudo towbar status
sudo towbar logs migrate api worker
```

To select a reviewed version, pass its published release tag. For example:

```bash
sudo towbar upgrade v2.0.52
```

The CLI accepts validated stable releases in its supported major version. It verifies GitHub Release assets by checksum, pulls images by digest, validates configuration, applies migrations and checks health and the running commit. Update discovery uses GitHub’s latest published stable release; draft and failed candidates leave latest unchanged.

If service replacement fails, the CLI attempts to restore the previous release and images. It cannot reverse database migrations. Review migration compatibility before reverting. See [Install and upgrade](/docs/self-hosting/cli/install-upgrade) for command details.

If an installation still uses `/etc/towbar/towbar.yml`, the CLI renames it to `/etc/towbar/config.yml` during upgrade, preserving its contents and permissions. If both paths exist, the upgrade stops so an operator can resolve the conflict without losing either file. An upgrade started with an older CLI installs the updated CLI first; run `sudo towbar restart` afterward to complete the rename. The repository-root `towbar.yml` manifest is unrelated and stays unchanged.

Successful upgrades retain the current and previous releases and images. Cleanup removes only older Towbar releases and unreferenced application images. Data volumes and unrelated Docker workloads remain untouched.

Configuration persists outside release directories. To change it:

```bash
sudo nano "$(towbar config path)"
sudo towbar config validate
sudo towbar restart
```

Do not replace `security.credentialsKey`: existing encrypted records require the matching key. Changing database values in the file does not rotate credentials inside the existing PostgreSQL volume.

<span id="back-up-the-control-plane" />

See [Backup and recovery](/docs/self-hosting/backup) for the complete database export and protected configuration procedure.

## Upgrade legacy image workloads

Older releases allowed arbitrary images as resources. The image-to-service migration keeps their existing workload IDs, saved secrets, volumes, and deployment history. It stops the upgrade if an image shares its manifest ID with an app in the same repository, or if its settings cannot be used by a Service. The failed migration leaves the database unchanged.

### Resolve a legacy image ID conflict

The migration error lists the repository, manifest ID, and image entity UUID for each conflict. Choose a new manifest ID for the image, such as `infisical-image`. Keep the existing entity and workload UUIDs so the saved secrets and history remain connected.

1. Back up the database and configuration. Keep deployments paused and stop the API and worker while changing the identity, so repository syncs cannot create a replacement workload.
2. Change the image's `id` in the repository manifest for every environment branch that declares it. Update any references to that ID. Keep the image, network alias, volume names, and stored secret values unchanged.
3. Open a PostgreSQL session on the control-plane host. Run the transaction below with the image entity UUID from the error and your new manifest ID. It updates all environments of that image together. A missing entity or conflicting ID stops the transaction.
4. Retry the upgrade before starting the API and worker. Afterward, convert the repository's image resource declaration to a `.service.yml` manifest with the same new ID, sync the repository, and check its saved secrets and deployment history before deploying.

```sql
BEGIN;
DO $$
DECLARE
  image_entity uuid := 'IMAGE-ENTITY-UUID';
  new_manifest_id text := 'infisical-image';
  repository_id uuid;
BEGIN
  IF new_manifest_id !~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$' THEN
    RAISE EXCEPTION 'Choose a valid manifest ID';
  END IF;
  SELECT source_id INTO repository_id
  FROM towbar_source_entities
  WHERE id = image_entity AND entity_type = 'resource' AND resource_type = 'image'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The image entity was not found';
  END IF;
  IF EXISTS (
    SELECT 1 FROM towbar_source_entities
    WHERE source_id = repository_id AND manifest_id = new_manifest_id
      AND id <> image_entity
  ) THEN
    RAISE EXCEPTION 'The new manifest ID is already used in this repository';
  END IF;
  UPDATE towbar_source_entities SET manifest_id = new_manifest_id
  WHERE id = image_entity;
  UPDATE towbar_apps
  SET manifest_id = new_manifest_id,
      config = jsonb_set(config, '{id}', to_jsonb(new_manifest_id))
  WHERE entity_id = image_entity;
END $$;
COMMIT;
```

Historical deployment snapshots keep the ID used at the time of deployment. Do not delete and re-import the workload, change its UUID, or recreate its secret records to resolve this conflict.

### Legacy image volume settings

Services require absolute application data paths such as `/data` or `/app/uploads`. Mounts cannot use `/`, a trailing slash, repeated slashes, `.` or `..` segments, or protected directories such as `/etc`, `/proc`, `/sys`, `/dev`, `/run`, and `/var/run`. Each volume needs a unique name, and mount paths cannot overlap.

If the migration reports an incompatible mount, keep the upgrade paused. Back up the volume and adapt the application to a supported data path on the installed release first. Keep its named volume and verify the application can still read its existing data. The migration also checks saved deployment snapshots; an incompatible historical snapshot requires operator review before retrying. Do not remove a volume or its data just to pass the check.

## Passkey authentication

The passkey update removes authenticator codes and their secrets. Registered passkeys are preserved. Existing passkey and authenticator sessions are revoked once during migration; password-only sessions remain valid. Authenticator-only accounts can sign in with their password and add a passkey. Existing passkey users can generate recovery codes from **Account Settings → Passkeys**.

## API key and MCP role scopes

The role-scope update replaces granular permissions with the Viewer, Member, and Admin roles. The migration revokes every MCP connection and every personal or team API key that does not have full administrative permissions. This includes all Read-only and Edit keys. Pending MCP authorization requests are also cancelled.

After upgrading, create replacement keys in **Account Settings → API Keys** or **Team Settings → API Keys** and update each consumer. Reconnect MCP clients and approve a new consent request. See [keys and permissions](/docs/api/authentication#keys-and-permissions) and [MCP setup](/docs/api/mcp).

## Admin account recovery

Use **Forgot password** when SMTP and the account's mailbox are available. Host operators can reset an Admin password, change a lost Admin email address, or reset recovery codes or remove lost passkeys for any active team member. Follow [Account recovery](/docs/self-hosting/account-recovery) for the maintenance window, commands, revoked access, and verification steps.

## Command-line operations

Run installation and upgrade commands on the control-plane host. See the [CLI reference](/docs/self-hosting/cli) for commands and diagnostics.

## Switch an older installation to GitHub Releases

Older versions read a separate release host. Before the first upgrade to a GitHub-only release, refresh the CLI on the control-plane host. Finish any active upgrade and follow the preparation steps above first.

Download the CLI from the target GitHub release and verify its checksum:

```bash
version="$(curl -fsSL https://api.github.com/repos/avgeek-oss/towbar/releases/latest | jq -er .tag_name)"
release_dir="$(mktemp -d)"
base="https://github.com/avgeek-oss/towbar/releases/download/$version"
curl -fsSL "$base/towbar" -o "$release_dir/towbar"
curl -fsSL "$base/SHA256SUMS" -o "$release_dir/SHA256SUMS"
(cd "$release_dir" && grep '  towbar$' SHA256SUMS | sha256sum --check) &&
sudo install -o root -g root -m 0755 "$release_dir/towbar" /usr/local/bin/towbar
rm -rf "$release_dir"
```

Run `sudo towbar upgrade "$version"` after refreshing the CLI. The updated CLI stops and disables the retired host upgrade service and removes its Compose override before replacing the control plane. Finish any active upgrade before refreshing the CLI.

## Retired integrations

Upgrades migrate protected runtime configuration to remove GitLab, Discord, and Telegram settings. Existing GitLab repositories are archived and their environment mappings are disconnected. Their deployed workloads and history remain available. Pending Discord and Telegram deliveries become failed with `PROVIDER_REMOVED`; completed delivery history is preserved.

Remove Discord and Telegram destinations from repository manifests before syncing them with this release. Configure Slack, email, or webhook push for future notifications. GitHub is the supported repository provider.
