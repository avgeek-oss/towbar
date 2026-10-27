# Towbar release publication

Towbar publishes its API, worker, and UI images to GHCR with the same version. GitHub Releases hosts the installer, CLI, source archive, image manifest, JSON schemas, and checksums.

## Publication

**Publish release images** requires a stable tag at exact `main` HEAD and matching package, CLI, and installer versions. GitHub Actions uses its built-in token with `packages: write` for images and `contents: write` for release assets. No external storage credentials or publication service are required.

1. Build AMD64/ARM64 images, record their digests, and verify anonymous pulls.
2. Assemble assets from the tagged commit, generate `SHA256SUMS` and `release.json`, and attach them to a draft GitHub release.
3. Download the draft assets with the workflow token, compare them to the assembled assets, verify checksums, and install them on a disposable Linux host. Health, version, doctor, upgrade support, and restart checks must pass.
4. Mark `release.json` validated and publish the GitHub release as latest. Verify anonymous downloads against the recorded checksums.

Draft assets are downloaded before installation because GitHub keeps drafts private. Only the disposable smoke test uses `TOWBAR_RELEASE_SMOKE=true` together with `TOWBAR_RELEASE_DIRECTORY` to read those local files. Normal installations require a published stable GitHub release and validated metadata. Images remain pinned by digest.

An installation failure removes the draft and leaves the previous latest release available. Published releases cannot be overwritten by this workflow. A new version requires a new tag.

Pull requests that change the release path, and dispatches with `dry_run`, run the `rehearsal` job instead of the publishing jobs. It bakes both platforms to local OCI archives on native runners, serves the amd64 images from a throwaway registry on the runner, assembles the artifacts for the untagged commit (`TOWBAR_REHEARSAL_REGISTRY`), and runs the same installation smoke with `TOWBAR_RELEASE_SMOKE_REGISTRY` pointing at that registry. The job holds only `contents: read` and no registry login. Tag and version checks against `main`, multi-platform manifests, GHCR access, the draft release and promotion run only in real releases.

## Downloads and upgrades

The latest installer is available at `https://github.com/avgeek-oss/towbar/releases/latest/download/install.sh`. Each installer pins the matching CLI, source, and image manifest to its own version. CLI and System Health update discovery use the GitHub Releases API. Schemas are flat release assets, such as `repository.v2.json`, with latest download links for editors.

## Repository transfers

Update `repository.json`, recording the old repository and any changed image registry in their respective `previous*` lists. Run:

```sh
pnpm repository:sync
pnpm --filter @workspace/towbar-core schemas
pnpm docs:sync
pnpm repository:check
```

Generation only writes declared outputs. Update documentation and image references explicitly; CI rejects obsolete aliases. Download and update URLs are derived from the repository identity.

## Retire the previous release host

Release this change and upgrade existing installations using the transition steps in `docs/docs/self-hosting/upgrades.md` before shutting down the previous download Worker. Older CLI and host-runner versions still need that host. Once every installation has switched, the Worker and its publication broker are no longer needed by Towbar. Retain or archive the old artifacts according to the operator's retention policy.
