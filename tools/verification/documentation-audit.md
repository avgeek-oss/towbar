# Documentation audit

Reviewed against Towbar v2.0.52 (`8e00c06af0f21bcb1e8b56d1bca4a8ee264e9ea1`) on 17 October 2026. This report records the review scope; it is not a product guide or a production deployment report.

## Coverage

| Published pages              | Review method                                                                                                                             |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 111 authored guides          | Read each page and compare its instructions, limits, UI names and lifecycle claims with the implementation.                               |
| 143 recipe pages             | Review the index and canonical generators for 142 examples. Check all 52 OSS recipes against upstream installation/configuration sources. |
| 154 REST reference pages     | Verify generated input/output contracts against the operation catalogue and response-schema exporter.                                     |
| 6 site, blog and legal pages | Review positioning, current navigation and historical context.                                                                            |

`documentation-page-audit.json` records every page, its content hash, implementation evidence and review notes. `documentation-upstream-recipes.json` records the official sources and configuration checks for the 52 OSS recipes. Unchanged pages remain in the ledger because review does not always require an edit.

The repository README was also reviewed as the documentation entry point. Its authentication, gateway origins, manifest paths and overview image were corrected, and repeated positioning copy was removed.

## Corrections

- Replace introductory theory and repeated workflow paragraphs with task links, prerequisites, working examples and observable checks.
- Correct the starter's file layout and start command; verify its app and health endpoint with the existing HTTP test.
- Update architecture diagrams and public/private port relationships. Keep configuration examples aligned with the generated schema.
- Document workspace/environment manifest identity, informational conflicts, retirement, permanent removal and repository ownership transfer. Include screenshots, lifecycle diagrams, refresh intervals and ownership-label drift.
- Update native OTEL collection, ClickHouse retention, log access, parsed/raw messages, URL filters, live trail and account-level table layouts. Remove obsolete external collector assumptions.
- Correct account/team navigation, API-key expiration, MCP protocol support, registry credentials and webhook signing requirements.
- Correct backup/restore limitations, rollback failure handling, whole-cluster control-plane recovery, preview isolation and server removal prerequisites.
- Correct recipe persistence, first-run credentials, Compose paths, preview domains and verification instructions. Keep generated pages derived from their canonical sources.

## Screenshots and rendering

The release screenshot manifest contains 61 UI states in light and dark themes: 122 refreshed images from the local fixture. Review included all contact sheets and corrected comparison/shared-secret captures. Nine retained GitHub setup screenshots were inspected separately; an obsolete setup/webhook screenshot was replaced with a field/value table.

Every published route was checked at 1440 × 1000. Every authored guide was also checked at 390 × 844 in dark mode. Checks cover HTTP responses, headings, MDX parsing, uncaught JavaScript errors and page overflow. These checks supplement content review; they do not prove every product interaction.

## Reproducible gates

```sh
pnpm docs:use-cases
pnpm docs:check
pnpm docs:examples:check
pnpm docs:api:check
pnpm postman:check
pnpm format:check
node --test examples/test/server.test.mjs
```

`docs:examples:check` is included in CI and the root verification command. It validates 12 repository manifests and 212 complete workload examples with Towbar's resolver, and eight OSS Compose projects with its admission validator. Another 67 YAML fragments are parsed only; fragments are not represented as complete validated manifests.

The API export check covers 154 REST operations, 222 response handlers and 63 MCP tools. The Postman check covers 154 generated requests. Mintlify build validation, anchor/redirect link checking and its MDX accessibility scan also passed. The existing primary color meets WCAG AA; Mintlify recommends AAA as an advisory.

## Limits

- Recipe review covers ports, runtime variables, persistence, dependency topology and first-run instructions. All 52 applications were not deployed end to end. Pinned images are examples, not a claim that every tag is the newest release.
- API reference verification checks contracts and generation. It does not execute every REST mutation against production.
- Screenshot data is local fixture data. Fixture screenshots do not establish production health or a completed upgrade.
- Code-block copying and the MCP accordion were exercised. Local Mintlify development returns 404 for Markdown export, so its whole-page copy is empty. The existing public host returned Markdown and copied page content successfully; that does not establish publication of this draft.
- This audit changes documentation and its verification/capture tools. Opening the PR does not publish the site or release the application.
