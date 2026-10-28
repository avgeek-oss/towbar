---
title: "Security"
description: "Review Towbar's supported versions, trust model, and private vulnerability reporting path."
---

Towbar deploys code and resolves credentials on infrastructure you control.
Security reports are treated as sensitive.

## Report a vulnerability

Do not report vulnerabilities in public issues, discussions or pull requests.
Follow the repository's
[security policy](https://github.com/avgeek-oss/towbar/blob/main/SECURITY.md):
use [GitHub private vulnerability reporting](https://github.com/avgeek-oss/towbar/security/advisories/new)
for the Towbar repository, or email
[support@avgeek.ltd](mailto:support@avgeek.ltd) if that is unavailable.

Include the affected version or commit, configuration assumptions, reproduction
steps, impact, and any suggested mitigation. Do not access data or systems you
do not own, and do not include live credentials in the report.

## Supported versions

Security fixes are provided for the latest stable release. Production operators
should pin a reviewed release and subscribe to repository security advisories.

## Security assumptions

- Branches mapped to connected environments are trusted deployment input and
  are protected by the repository owner.
- Same-repository branches are trusted executable input for Services with Preview
  enabled. Preview deployments use separate, least-privilege, non-production
  credentials. Fork pull requests are not Preview input.
- Public HTTP services are behind TLS. PostgreSQL, Temporal, Temporal UI, and
  SSH are restricted by host and network controls.
- Secrets are encrypted with AES-256-GCM. Admins and Members can update declared values and shared references. Only Admin browser sessions can reveal stored credentials after recent authentication. Reveal responses disable caching; metadata, mutation responses and Temporal inputs exclude values. Viewer sessions cannot access secret-management routes or mutate shared resources.
- Personal API keys intersect stored grants with live membership. Team keys are explicit service identities. Browser-only account/key creation and credential reveal are not available through REST or MCP.
- Keep the installation encryption key separate from database backups. Losing
  the key makes stored secrets unrecoverable. Database access plus the
  installation key permits decryption, so both are trusted operational
  boundaries.
- The optional workspace AWS identity is scoped only to required S3 backup operations.
- Destination hosts use SSH keys, pinned host identity, current security
  updates, and least-privilege network rules.
- Installation secrets are unique, randomly generated, and never committed.
- [Account recovery](/docs/self-hosting/account-recovery) commands bypass the
  mailbox and passkey checks. Only trusted operators with shell access to the
  control-plane host can run them.

Towbar does not provide a security boundary against a malicious contributor who
is authorized to modify a deployed environment branch or Preview branch. Review, branch
protection, secret separation, and the decision to enable Preview are part of
the trust model.

This page is Towbar's security guidance. The repository's
[security policy](https://github.com/avgeek-oss/towbar/blob/main/SECURITY.md),
shared by every Avgeek OSS project, covers reporting and supported versions.
