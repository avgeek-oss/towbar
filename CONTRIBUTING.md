# Contributing to Towbar

Thank you for helping improve Towbar.

## Before you start

- Use an issue for significant behavior or schema changes so the design can be
  discussed before implementation.
- Never include customer data, private keys, access tokens, production IPs, or
  proprietary assets in an issue, fixture, test, or commit.
- Security vulnerabilities must follow [SECURITY.md](SECURITY.md), not a public
  issue.

## Design system dependency

The dashboard uses `@avgeek-oss/design-system` from npmjs.org. Shared UI
belongs in that package; Towbar owns API calls, access checks, routing, and
product-specific composition in `apps/towbar-web-app` and `packages/towbar-web-ui`.
Use the package's documented exports and import its stylesheet once. The Next.js
navigation adapter connects shared links to Towbar's router.

Use the published auth, account settings, and team settings patterns with their
standard copy. Keep app wrappers limited to typed data, API calls, navigation,
and supported capabilities. Add a missing common surface to the design system
instead of copying a form into Towbar. Public verification-link requests use
`VerificationEmail`; ownership verification, passkeys, and one-use recovery
codes remain separate flows. Do not add authenticator/TOTP code flows. Report
submission failures through one bottom-center toast.

The shared packages are public on npmjs.org. Local installs, CI and source Docker builds do not require a package-registry token. The repository maps `@avgeek-oss` to npmjs.org; refresh the lockfile when migrating an older checkout.

## Local checks

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm verify
```

Prefer the narrowest package check while iterating. Run the root verification
before opening a pull request. The installer manages operator configuration in `/etc/towbar/config.yml`.
For contributor-only Compose checks, generate disposable YAML with Python 3
and PyYAML, then render the container environment:

```bash
mkdir -p tmp
python3 infra/runtime_config.py init --yaml tmp/config.yml
python3 infra/runtime_config.py render --yaml tmp/config.yml --env .env
docker compose config --quiet
docker compose build
```

## Public demo

The public demo uses the current dashboard and session-isolated development
fixtures. See [its architecture, checks, and activation runbook](infra/demo/README.md).
Changes to fixture routes must be reviewed against the public gateway allowlist.

## Documentation

The Mintlify project lives in `docs/`, organized into Introduction, Using Towbar,
and API & MCP. Introduction covers the product and self-hosting; product workflows
belong in Using Towbar; client connection guides and individual generated references
belong in API & MCP. Contributor source under `docs/contributors/` is retained in Git
and excluded from public publication through `.mintignore`. The detailed
[architecture walkthrough](docs/contributors/architecture.md) remains available there.
[Avgeek OSS Mintlify Docs](https://github.com/avgeek-oss/oss-docs) owns the shared homepage
layouts, header behavior, screenshots, and authoring conventions. Towbar owns
`docs/site.json`, product content, navigation destinations, assets, and generated
API schemas. The kit dependency lives in the `towbar-docs` workspace so runtime
Docker builds do not install or package documentation tooling. Upgrade it with
`pnpm --filter towbar-docs add -D @avgeek-oss/mintlify-docs@<version>`.
Write task pages around prerequisites, the action, and a way to verify
the result. Keep manifest field details in the reference and link to them from guides.
Use documentation-only IPs and domains, and never include credentials in examples
or screenshots. Feature screenshots should include light and dark variants,
descriptive alt text, and enough resolution for Retina displays.

After changing the site configuration, upgrading the pinned documentation kit,
or changing published manifest examples, regenerate the checked-in artifacts:

```bash
pnpm docs:sync
pnpm docs:check
pnpm docs:examples:check
```

`pnpm docs:check` rejects edits to shared generated files and verifies page
metadata, navigation, internal links, and published artifacts. Import snippets
from `/snippets/oss/` directly in MDX pages; never edit `docs/oss-docs.css`,
`docs/oss-docs.js`, `docs/docs.json`, or `docs/snippets/oss/` by hand. Keep
product logo and footer styles in `docs/style.css`; retain native Mintlify header,
content, and sidebar layout.

Edit recipe inputs in `tools/use-case-catalog.json`, `tools/oss-use-case-recipes.mjs`
or `tools/oss-compose-recipes.mjs`, then run `pnpm docs:use-cases`. Do not edit
generated recipe pages directly. `pnpm docs:examples:check` validates complete
workload examples with Towbar's resolver and OSS Compose projects with its admission
validator. Partial YAML snippets are parsed only; they are not complete manifests.

Install the [Mintlify CLI](https://www.mintlify.com/docs/cli/install), then run
`mint dev` from `docs/` for a local preview. Before publishing, run `mint validate`
and `mint broken-links` from that directory. Review changed pages on desktop and
mobile, in light and dark mode. Configure Mintlify with `/docs` as this repository's
documentation path.

## Pull requests

- Keep each change focused.
- Add tests for behavior changes.
- Update the schema and documentation together.
- Explain security, migration, and rollback implications when applicable.
- Preserve Source scoping and avoid logging secret values.

## Release images

Update only the release version in the root `package.json`, then run
`pnpm cli:build` and commit the generated installer and CLI files. The dashboard,
API, installer, and CLI all use that version. `pnpm cli:check`, CI, and the release
workflow reject stale generated scripts. Update the release notes in
`CHANGELOG.md`; version numbers in historical notes and test scenarios do not
need to change.

Edit the installer in `infra/install.sh.in` and CLI modules in `infra/towbar-cli/`.
`install.sh`, `infra/towbar`, and `infra/towbar-cli/00-version.sh` are generated;
run `pnpm cli:build` after changing their sources. Installed hosts do not need
Node.js to run them.

After the release pull request merges, create and push the matching `v2.x.y` tag
from the merge commit, then run
the **Publish release images** workflow from `main` with that tag. The workflow
refuses a tag that does not point at the selected `main` commit.

The workflow builds each API, worker, and dashboard image on matching native
amd64 and arm64 runners. It validates both platform digests, combines them into
multi-platform images in GitHub Container Registry, and attaches their immutable
digests in `towbar-images.json` to a draft release. It installs the candidate in local mode on a disposable
GitHub-hosted Ubuntu runner, runs `towbar doctor`, and proves that `towbar restart`
reuses the running application containers before publishing the release. Its diagnostic evidence is retained for
14 days. A failed smoke test withdraws the release so the installer cannot
select it. Release tag names cannot be reused, so fix the failure under a
new patch version.

GHCR package visibility is separate from repository visibility. The three Towbar
container packages must be public so an installation can pull them without GitHub
credentials. The workflow verifies anonymous access before attaching the manifest.
When a package is published for the first time, set its visibility to **Public**
in the organization package settings and rerun the failed manifest job.

Project stewardship and the current code owner are recorded in
[MAINTAINERS.md](MAINTAINERS.md).

By contributing, you agree that your contributions are licensed under the
Apache License 2.0.
