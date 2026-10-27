---
title: "Backup and recovery"
description: "Protect the control-plane databases, encryption keys, and installation state."
---

Control-plane backups protect Towbar's accounts, encrypted credentials, deployment history, and Temporal workflows. Workload databases and volumes need their own [backups](/docs/backups) and [restore plans](/docs/restores).

## Create a recovery point

The PostgreSQL volume contains Towbar and Temporal databases. Back up the whole cluster, not just the `towbar` database. After active operations finish, stop the API and worker during the export so they cannot change control-plane state. Deployed workloads keep running. On a standard CLI installation:

```bash
set -o pipefail
sudo towbar compose stop web-app api worker
backup_dir="/var/backups/towbar/$(date -u +%Y%m%dT%H%M%SZ)"
sudo install -d -m 0700 "$backup_dir"
sudo towbar compose exec -T postgres pg_dumpall -U towbar | \
  sudo sh -c 'umask 077; cat > "$1/control-plane.sql"' sh "$backup_dir"
```

After a successful export, resume the control plane:

```bash
sudo towbar compose up --detach --wait api worker web-app
sudo towbar status
```

Keep a restricted backup of the file reported by `sudo towbar config path` separately from the database export. It contains the keys needed to decrypt stored credentials. Copy the backups off the host and test them against an isolated installation before relying on them. If the export command fails, discard its partial file and retry after resolving the error.

## Preserve installation state

Store the configuration copy separately from the database export with restricted access. Record `sudo towbar version` and retain the matching release assets. Preserve Caddy's certificate and ACME volumes as part of a host recovery plan; do not remove data volumes while diagnosing startup.

## Test recovery

Use an isolated host and the recorded release, with deployment egress blocked so restored workflows cannot change production servers. Keep its dashboard and API private during the test.

1. Restore the complete PostgreSQL cluster, including Temporal databases, while the API and worker are stopped. Use PostgreSQL tooling compatible with the source version.
2. Restore the matching protected configuration and its original encryption and signing keys. Apply the recorded release's installation settings; a fresh encryption key cannot decrypt the saved records.
3. Start PostgreSQL and Temporal, inspect schema job results, then start the API and worker only after reviewing pending workflows and server access.
4. Run `sudo towbar doctor`, inspect System health, and verify accounts, inventory, and encrypted credential access. Keep the isolated installation unable to execute production work.

A backup is usable only after a recovery rehearsal succeeds. Review [Upgrades](/docs/self-hosting/upgrades) for migration and admission recovery, and [Account recovery](/docs/self-hosting/account-recovery) for a lost administrator login.
