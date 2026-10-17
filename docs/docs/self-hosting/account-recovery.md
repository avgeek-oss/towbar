---
title: "Account recovery"
description: "Recover a password, change a lost Admin email address, or reset a user's passkeys from the Towbar host."
---

Use **Forgot password** on the sign-in page when the account can receive email. An unused recovery code can replace a passkey once after a valid password. If both are unavailable, a trusted operator with shell access to the Towbar control-plane host can use the commands below.

These commands bypass the usual mailbox or passkey check. Verify the account owner's identity first. They are available only on the host, not through the dashboard, REST API, or MCP. They cannot create an account, promote a member, or recover a disabled account.

## Start a recovery session

SSH into the control-plane host. Keep the database running, and stop request handling and workers while changing credentials:

```bash
sudo towbar compose stop web-app api worker
```

Stopping the control plane does not stop deployed services. Allow active deployments and operations to finish before this maintenance window. Keep `/etc/towbar/config.yml`, including `security.credentialsKey` and `security.internalHmacSecret`, unchanged.

## Recover an Admin password

```bash
sudo towbar compose run --rm --no-deps api node dist/cli/recover-admin.js \
  --email=admin@example.com
```

The command prints a new temporary password once. Copy it privately; it is never sent by email or included in the audit event. Sign in and choose a new password before using the dashboard. Recovery revokes this user's browser sessions, personal API keys, pending password-reset links, and pending email changes. Team API keys and the user's role remain unchanged.

Password recovery works without SMTP. The temporary password is generated with cryptographic randomness and does not require an external password-breach lookup. Normal password changes retain the installation's password policy.

## Change an Admin's email address

Use the existing email to identify the account and the new email as a separate option:

```bash
sudo towbar compose run --rm --no-deps api node dist/cli/recover-admin.js \
  --email=old-admin@example.com --new-email=new-admin@example.com
```

This also resets the password and revokes access as described above. An address already used by another account is rejected without changing either account. The new address starts unverified. After signing in with the printed password and choosing a new one, verify the address in **Account Settings → Email & Password**. Security notices are queued for the old and new addresses when SMTP becomes available.

## Reset passkey recovery codes for any user

This works for an active Admin, Member, or Viewer:

```bash
sudo towbar compose run --rm --no-deps api node dist/cli/reset-user-mfa.js \
  --email=person@example.com
```

It removes recovery codes, revokes sessions, personal API keys and pending recovery links, and records an audit event. It retains the current password and passkeys. The user can sign in with their password, verify any retained passkey, and add a replacement under **Account Settings → Passkeys**. If the password is also lost, use email password recovery; an Admin account can use the password command above.

For an Admin who lost both password and passkeys, combine recovery in one command:

```bash
sudo towbar compose run --rm --no-deps api node dist/cli/recover-admin.js \
  --email=admin@example.com --reset-mfa --remove-passkeys
```

Passkeys are separate credentials. If a device is lost or its credentials may be compromised, append `--remove-passkeys` to either command. This removes every registered passkey for that user; other accounts are unaffected. Without that option, a retained passkey is still required as the second factor when recovery codes have been reset.

## Resume and verify

```bash
sudo towbar compose up --detach --wait api worker web-app
sudo towbar status
```

Verify a fresh sign-in, the expected role, and the replacement passkey. Replace revoked personal API keys in any clients that used them. Security notifications are delivered through the transactional email queue after the worker resumes; a successful command does not guarantee email delivery.

For a development checkout, the equivalent commands are `pnpm --filter towbar-api auth:recover-admin --email=admin@example.com` and `pnpm --filter towbar-api auth:reset-mfa --email=person@example.com`, with the intended database and credential environment loaded. Never point a recovery command at an unrelated installation.
