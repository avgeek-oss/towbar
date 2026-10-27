---
title: "Upgrades and recovery"
description: "Plan a release upgrade, protect control-plane state, and recover Admin access."
---

import { Screenshot } from "/snippets/oss/screenshot.jsx";

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

## Admin account recovery

Use **Forgot password** when SMTP and the account's mailbox are available. Host operators can reset an Admin password, change a lost Admin email address, or reset recovery codes or remove lost passkeys for any active team member. Follow [Account recovery](/docs/self-hosting/account-recovery) for the maintenance window, commands, revoked access, and verification steps.

## Command-line operations

Run installation and upgrade commands on the control-plane host. See the [CLI reference](/docs/self-hosting/cli) for commands and diagnostics.

## Switch an older installation to GitHub Releases

Older versions read a separate release host. Before the first upgrade to a GitHub-only release, refresh the CLI and the host upgrade service on the control-plane host. Finish any active upgrade and follow the preparation steps above first.

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

For an installation with host-managed upgrades enabled, prepare the verified target release, then replace the idle runner before starting the upgrade:

```bash
sudo towbar upgrade-service plan "$version"
sudo systemctl stop towbar-upgrade
sudo python3 "/opt/towbar/releases/$version/infra/upgrade-runner/install.py"
sudo systemctl start towbar-upgrade
sudo towbar upgrade "$version"
```

If host-managed upgrades are disabled, run `sudo towbar upgrade "$version"` after refreshing the CLI. The configuration and database stay in place. After this transition, later CLI and System Health upgrades use GitHub Releases directly.

## Upgrade from System Health

An Admin can upgrade from **System Health → Towbar version** after the installation operator enables in-app upgrades. Keep a recent database backup and a protected copy of the configuration before upgrading.

1. Select **Review upgrade** when the yellow **Update available** badge appears.
2. Review the version change and the readiness check. If deployments or operations are active, wait for them to finish, then select **Check again**.
3. Select **Upgrade** to begin. New deployments and operations pause while Towbar applies the update.
4. Keep the modal open to follow progress. It reconnects automatically if the dashboard loses contact during a restart.
5. Check the final result in the same modal. A successful upgrade shows the installed version; a failed upgrade links to the recovery instructions below. You can reopen the modal with **View upgrade**.

The screenshots use a local fixture to demonstrate upgrade states.

<Tabs>
  <Tab title="Ready">

<Screenshot light="/assets/release-v2/upgrade-ready-light.jpg" dark="/assets/release-v2/upgrade-ready-dark.jpg" alt="Review the new version and the readiness check before upgrading." caption="Review the new version and the readiness check before upgrading." width={3200} height={1800} />
  </Tab>
  <Tab title="Work in progress">

<Screenshot light="/assets/release-v2/upgrade-blocked-light.jpg" dark="/assets/release-v2/upgrade-blocked-dark.jpg" alt="Wait for active deployments and operations to finish, then check again." caption="Wait for active deployments and operations to finish, then check again." width={3200} height={1800} />
  </Tab>
  <Tab title="In progress">

<Screenshot light="/assets/release-v2/upgrade-applying-light.jpg" dark="/assets/release-v2/upgrade-applying-dark.jpg" alt="The same modal follows the upgrade and reconnects during a restart." caption="The same modal follows the upgrade and reconnects during a restart." width={3200} height={1800} />
  </Tab>
  <Tab title="Successful">

<Screenshot light="/assets/release-v2/upgrade-succeeded-light.jpg" dark="/assets/release-v2/upgrade-succeeded-dark.jpg" alt="The result confirms the installed version and that deployments and operations can resume." caption="The result confirms the installed version and that deployments and operations can resume." width={3200} height={1800} />
  </Tab>
  <Tab title="Failed">

<Screenshot light="/assets/release-v2/upgrade-failed-light.jpg" dark="/assets/release-v2/upgrade-failed-dark.jpg" alt="A failed upgrade shows a safe reason and links to recovery help." caption="A failed upgrade shows a safe reason and links to recovery help." width={3200} height={1800} />
  </Tab>
</Tabs>

### Enable in-app upgrades

Standard CLI installs and upgrades enable the service automatically when supported. If an older CLI left it disabled:

```bash
sudo towbar upgrade-service enable
sudo systemctl status towbar-upgrade
```

Requirements are Linux with systemd, Python 3, Docker Compose v2 and standard upstream paths (`/opt/towbar`, `/etc/towbar` and `/usr/local/bin/towbar`). Both releases must support admission protocol 2. Custom paths, forks, container-only and Kubernetes installations use manual upgrades. Major-version or protocol changes require a host maintenance window.

Setup restarts the API with a private runner socket and dedicated group. The root-only `/etc/towbar/upgrade-group.json` records that group. Setup does not adopt an existing host group or add host users; startup rejects shared IDs or host membership. Only the API mounts the socket. It receives no Docker socket, root privileges or shell endpoint.

To replace an older runner, wait for any upgrade to finish, stop the idle service with `sudo systemctl stop towbar-upgrade`, then run `sudo towbar upgrade-service enable`. Enabling refuses a running service and rotates its token at startup.

Upgrade review requires a recently authenticated Admin. Preparation downloads and verifies the release; confirmation expires after 15 minutes. A changed installed version or target commit requires another review. Keep a tested database backup and protected configuration copy. The runner does not create backups.

Queued or active deployments, source syncs, resource/server operations, scans, preview cleanup, worker activities and terminals block upgrades. Confirmation pauses new admissions and checks readiness again. A blocked attempt reopens admission without replacing services. Delayed worker tasks cannot perform effects while paused. Webhooks rejected during the pause need redelivery or source sync afterward.

The runner invokes the CLI with the confirmed version and commit. Closing the modal or restarting the API does not stop the job; **View upgrade** reopens its status. After installation, the runner updates its code and unit, reopens admission, saves the result and restarts. Another upgrade remains blocked until the restart succeeds. A failure requires the host recovery steps below; inspect the saved result to determine whether admission is still paused.

With the service enabled, `sudo towbar upgrade [VERSION]` uses the same readiness and job path. Only root on the host can acknowledge recovery.

## Recover a host-managed attempt

Attempts and private CLI output are stored in `/var/lib/towbar-upgrade`, outside containers. Read the latest job record and check service health on the control-plane host:

```bash
sudo systemctl status towbar-upgrade
sudo journalctl -u towbar-upgrade
sudo cat /var/lib/towbar-upgrade/job.json
sudo towbar doctor
sudo towbar logs migrate api worker
```

The job record's `id` identifies `/var/lib/towbar-upgrade/ATTEMPT-ID.log`. These root-only logs contain CLI output; the browser shows only the stage, exit code or safe failure reason. Keep logs protected and apply a retention policy.

Check the running release and database compatibility. Restoring previous images does not reverse migrations; use a tested database and configuration backup when required. A reachable dashboard alone does not prove recovery.

A runner restart marks unfinished attempts **interrupted** without retrying. Admission may remain paused or may have reopened before the result was saved. Inspect its state, services, database and pending work before resuming:

```bash
sudo towbar upgrade-service resume --acknowledge-recovery
```

Resume checks `towbar doctor`, refuses unresolved blockers, and only clears the pause belonging to the recorded attempt. Worker and terminal leases do not expire automatically: an interrupted SSH operation may still be changing a remote host. Inspect leases with:

```bash
sudo towbar compose exec -T postgres psql -U towbar -d towbar -c \
  'SELECT id, kind, created_at FROM towbar_upgrade_leases ORDER BY created_at;'
```

Before clearing a lease, stop the worker, close terminals and verify that the remote operation ended. Resolve its deployment or operation record. A database administrator may delete that specific lease by ID; never truncate the table or use age alone. After resolving blockers, resume admission and restart the worker.

If the API cannot reconnect, continue recovery over SSH. Repair the database or services with the host CLI; do not run the upgrade inside a container. Leave the runner state and admission record intact until you have established the outcome.
