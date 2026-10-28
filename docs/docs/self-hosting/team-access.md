---
title: "Team access"
description: "Set up Admin, Member and Viewer access, invitations, API keys, passkeys, and account recovery."
---

Towbar v2 has one team per installation. The person completing setup becomes an Admin. Team Settings is available to Admins; Account Settings is available to every signed-in user.

## Roles

| Capability                                                                   | Admin | Member | Viewer       |
| ---------------------------------------------------------------------------- | ----- | ------ | ------------ |
| Read operational inventory, deployment history, monitoring and redacted logs | ✅    | ✅     | ✅           |
| Connect repositories, change branch mappings and sync inventory              | ✅    | ❌     | ❌           |
| Update declared secret values and shared-secret references                   | ✅    | ✅     | ❌           |
| Configure Scout Agent and alert rules                                        | ✅    | ✅     | ❌           |
| Deploy, operate workloads, prepare servers, back up or restore               | ✅    | ❌     | ❌           |
| Authorize GitHub connections and manage SSH keys                             | ✅    | ❌     | ❌           |
| Reveal stored workload secrets after recent authentication                   | ✅    | ❌     | ❌           |
| Manage members, invitations, team settings and team API keys                 | ✅    | ❌     | ❌           |
| Secure own account and manage own personal API keys                          | ✅    | ✅     | 🔑 Read-only |

Members can inspect repository configuration and inventory. Admins manage connections, branch mappings, and synchronization. Removing a repository connection does not authorize runtime cleanup.

Secrets can be changed without revealing their existing values. Members can preserve masked values or replace them and can use shared references; they cannot reveal or export stored secrets. Viewers do not see secret-management pages.

For step-by-step dashboard instructions, see [Team settings](/docs/team-settings), [Personal settings](/docs/personal-settings), and [SSH keys](/docs/ssh-keys).

## Add people

Under **Settings → Team Settings → Members**, choose **Create invite**, enter the recipient's email and select Admin, Member or Viewer. Invitations expire after seven days. A new recipient verifies their email with a one-time code before creating their account and password. Existing accounts sign in with the invited email and accept without changing their password.

Resend creates a replacement invitation. Revoking an invitation or demoting/removing its inviting Admin invalidates pending invitations and cancels their queued mail. Opening a link for preview does not consume it. Delivery status means SMTP acceptance, not confirmed inbox delivery.

There must always be at least one active Admin. Removing a member revokes their sessions and personal keys. Operational history remains. Rejoining does not reactivate old keys.

## Personal and team keys

Open **Account Settings → API Keys** for your own keys. Admins manage team keys under **Team Settings → API Keys**, and stored SSH keys under **Manage → SSH keys**. The MCP Guide is in Account Settings; the REST reference is on this documentation site.

- Administrative keys (Edit with administrative permissions) follow Towbar's current automation permissions, including new capabilities introduced by upgrades. This applies to personal and team keys. Upgrades recognize complete, unmodified historical admin grant snapshots; narrower or previously changed policies retain their saved grants. MCP OAuth consent, Read-only, and ordinary Edit keys remain scoped to their saved grants.
- Personal keys also follow the owner's current role and membership. Demotion permanently converts a full administrative key to scoped permissions and removes access above the new role. Promotion does not restore removed grants or full administrative access; create a replacement key when broader access is needed.
- Team keys represent the team and survive the creator leaving. All Admins can view and revoke them.
- Choose Read-only or Edit. Only Admins can include administrative permissions with Edit. Viewers are limited to Read-only. SSH terminals, credential reveal, and account/key management stay in the browser.
- You choose Read-only, Write, or Administrator for MCP connections in the shared consent form. Administrative consent requires a recent password or passkey confirmation and an Admin role. OAuth permissions stay scoped to the approved grants; existing connections must reconnect and obtain fresh consent to gain deployment access. Any role change, including a promotion, automatically revokes the user's MCP connections.
- Choose an expiry when creating a key; there is no preselected expiry. Only Admins can choose no expiry. Copy the token when creating it: Towbar cannot show it again. Replace with an overlapping key, verify the consumer, then revoke the old key.

Queued operations retain their requesting identity and permissions. Upgrades cannot add permissions to already queued work. Towbar rechecks current authority, expiry and revocation before starting effects; a role change or revoked key can prevent pending work. Work already performed cannot be undone by key revocation. Automatic GitHub and maintenance work uses narrow system authority and current repository/environment controls.

## Account security

Under **Account Settings**, use Profile for your display name, Email & Password for sign-in details, Sessions for active sessions, and **Passkeys** for passkeys and recovery codes. Store recovery codes separately; each code is single-use. Admins should register a passkey.

Passwords require 15–1,024 characters and are checked against known compromised passwords. If the check is unavailable, retry later. Operators of isolated installations can explicitly disable it with `security.passwordBreachCheck: false`.

Forgot password sends a short-lived, single-use link when SMTP is configured. Responses do not disclose whether an email exists. A successful reset revokes sessions and requires normal sign-in. Use the [local recovery command](/docs/self-hosting/account-recovery) if email or passkeys are unavailable.

## Transactional email

Configure SMTP under `notifications.providers.smtp` in `/etc/towbar/config.yml` and run `sudo towbar restart`. Port 465 usually uses implicit TLS; a submission port such as 587 uses STARTTLS. Towbar requires encrypted delivery and validates the server certificate. The SMTP hostname must resolve to public addresses; private network relays are not supported by this transport.

Use a verified sender domain and apply the SMTP provider's SPF, DKIM and DMARC instructions. Test the SMTP configuration and an invitation with a mailbox you control before relying on password recovery. Notification category recipients control deployment/incident mail; account and team messages always use their server-selected recipients and are independent of those categories. The subject prefix is fixed to `[Towbar]`.

Towbar queues transactional mail and retries temporary delivery failures. Account messages use their own recipients, independently of notification category subscriptions. A mail server accepting a message does not prove inbox delivery.

### Email changes and passkeys

Use [Personal settings](/docs/personal-settings) to change an email address, update a password, or manage passkeys and recovery codes. Email changes require mailbox confirmation. Passkeys are tied to the configured dashboard domain; password resets do not remove them.

Sensitive account changes require recent authentication. For lost passwords, email addresses, or passkeys, follow [Account recovery](/docs/self-hosting/account-recovery).
