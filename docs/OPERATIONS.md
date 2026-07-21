# Operations And Release Readiness

Checked on 2026-06-19 against `my-app/package.json`, Tauri config, scripts, and
current app routes.

## Local Setup

Canonical contributor / agent setup: [DEV_SETUP.md](DEV_SETUP.md).

Short path from `my-app/`:

```bash
pnpm install
cp .env.example .env.local
pnpm prisma:generate
pnpm desktop:dev
```

The desktop dev command starts Next with `LUNERY_DESKTOP=1`, boots PGlite, and
opens `/studio` in the Tauri WebView. Browser requests for Studio workspace
routes redirect to the standalone website.

## Required Environment

Minimum local variables:

- `DATABASE_URL`: PostgreSQL connection string.
- `ECOM_STORAGE_DIR`: optional absolute path for local media storage. Omit it
  to use the visible Lunery profile media directory.

Desktop bridge variables are set by the desktop runtime, not by users in normal
operation:

- `LUNERY_DESKTOP`
- `LUNERY_DESKTOP_BRIDGE_URL`
- `LUNERY_DESKTOP_BRIDGE_TOKEN`

## Verification Gates

Run from `my-app/` before reporting a shipping-ready code change:

```bash
pnpm typecheck
pnpm lint
pnpm test:unit
pnpm build
pnpm ui:check
pnpm ai:freshness
```

Add these when the touched surface requires them:

- `pnpm desktop:check` when desktop scripts, Tauri config, or runtime bridge
  code changes.
- `cargo test` from `my-app/src-tauri` when Rust files change.
- Browser or desktop preview for rendered UI changes.
- `git diff --check` before handoff.

## Build And Desktop Release

`pnpm build` runs:

1. `prisma generate`
2. `next build`
3. `node scripts/prepare-standalone.mjs`

Tauri release builds run the configured `beforeBuildCommand`:

```bash
pnpm desktop:clean && pnpm build && pnpm desktop:prepare
```

That command removes stale generated app artifacts, rebuilds the standalone
Next server, and fetches/bundles local runtime assets.

`pnpm desktop:build` is the single platform packaging entrypoint. On macOS it
asks Tauri for the `.app` only, then creates a 660×400 drag-install DMG with the
SHA256-locked `dmgbuild==1.6.7` toolchain. On Windows it explicitly requests the
NSIS installer. `pnpm desktop:build:local` uses the same implementation while
forcing an unsigned macOS package for local QA. Both macOS paths verify the DMG,
mounted app, `/Applications` link, arrow background, and fixed icon positions;
the generated `*-layout.png` is the headless layout evidence.

Pull-request and `main` validation use isolated GitHub-hosted runners. Web
product gates run on `ubuntu-latest`; desktop Rust gates run on the Apple
Silicon `macos-latest` image. Fork and same-repository pull requests execute the
same two jobs, with pnpm and Cargo caches restored through GitHub Actions.

## Release Signing (fail-closed)

`.github/workflows/desktop-release.yml` refuses to publish an unsigned installer
on a tag push: if a platform's signing secrets are absent, the build job fails
before producing an artifact. `workflow_dispatch` is build-only and may use the
unsigned local path when signing secrets are absent; it never publishes. macOS
release builds are signed with an Apple Developer ID and notarized + stapled;
Windows installers are Authenticode-signed and timestamped; each release ships
`SHA256SUMS.txt`.

The macOS release order is fail-closed: sign/notarize/staple the `.app`, create
the DMG from that final app, sign/notarize/staple the DMG, then run signature,
Gatekeeper, stapler, mounted-layout, and `hdiutil verify` gates. The workflow
expects the Developer ID identity named by the workflow to be available to the
ephemeral release job. CI receives notarization credentials from encrypted
GitHub secrets and never writes them into the runner checkout.

### New repository GitHub secrets

Configure every custom secret referenced by
`.github/workflows/desktop-release.yml` in the new repository:

- `APPLE_SIGNING_IDENTITY`: exact Apple Developer ID Application identity used
  by Tauri, sidecar signing, and signature verification.
- `APPLE_ID`: Apple account submitted to `notarytool`.
- `APPLE_PASSWORD`: app-specific Apple password submitted to `notarytool`.
- `APPLE_TEAM_ID`: Apple Developer team used for notarization.
- `APPLE_CERTIFICATE`: base64-encoded Developer ID Application certificate
  (`.p12` export) imported into a temporary keychain on the hosted runner.
- `APPLE_CERTIFICATE_PASSWORD`: export password for `APPLE_CERTIFICATE`.

Optional secrets (Windows Authenticode; when absent, tag builds publish an
unsigned Windows installer with a workflow warning instead of failing):

- `WINDOWS_CERTIFICATE`: base64-encoded Windows code-signing `.pfx` imported
  only for the signing step.
- `WINDOWS_CERTIFICATE_PASSWORD`: password for `WINDOWS_CERTIFICATE`.

Releases publish to this repository's own Releases page using the built-in
`GITHUB_TOKEN`; no cross-repository release token exists anymore.

The workflow also references `GITHUB_TOKEN` to authenticate pinned sidecar
asset lookups. GitHub creates that token automatically for each workflow run;
the repository owner does not create a secret with that name.

Required GitHub Actions variables:

- `SIGNING_CREDENTIAL_OWNER`: the named maintainer accountable for both signing
  chains.
- `NOTARIZATION_CREDENTIAL_ROTATED_AT`: the last Apple notarization credential
  rotation date in `YYYY-MM-DD`; tag builds fail when it is missing, in the
  future, or older than 180 days.
- `WINDOWS_EXPECTED_PUBLISHER`: the expected publisher text in the Windows
  certificate subject; CI rejects any other signer. Only required once the
  optional Windows signing secrets are configured.

Ownership and rotation:

- The named owner rotates Apple notarization credentials at least every 180
  days and immediately after suspected exposure. The workflow enforces the
  recorded rotation date rather than relying on an unchecked runbook statement.
- The historical local-notarization credential used for the earlier manual
  signed build must be rotated before setting
  `NOTARIZATION_CREDENTIAL_ROTATED_AT`; until then, tag publishing remains
  fail-closed.
- Signing an installer establishes publisher identity; it does not instantly
  clear Windows SmartScreen reputation, which builds over download volume.

## Release Checklist

- Browser access to Studio-only surfaces redirects to
  `https://www.lunerylab.com/download`.
- The separately maintained public website points `/download` at the current release assets.
- `ai:freshness` passes with exact model ids, source URLs, and checked dates.
- `ui:check` passes without expanding raw visual-value baselines.
- No `/billing`, `/license`, credits, Pro, team-tier, or hosted account surface
  is reintroduced.
- BYOK providers require explicit model ids unless the provider is a fixed
  single-operation mode.
- Generated data and build output are ignored and reproducible.
- Desktop package includes `desktop-server` and `engine` resources only after a
  fresh `desktop:clean` and rebuild.

## Cleanup Policy

Safe cleanup:

- Run `pnpm desktop:clean` to remove stale `.next`, `desktop-server`,
  `desktop-dist`, and desktop bundle outputs.
- Remove `.DS_Store` files.
- Remove generated reports, screenshots, logs, and temporary files only after
  confirming they are not tracked source, public assets, or runtime user data.

Do not blanket-run destructive cleanups such as `git clean -fdX` in this
workspace. That would remove `.env.local`, `node_modules`, Tauri build cache,
local runtime engines, and generated user media.

Treat these as intentional unless the task explicitly says to wipe local state:

- `my-app/node_modules/`
- `my-app/.env.local`
- `my-app/src-tauri/target/`
- `my-app/engine/`

Do not read, migrate, or write legacy repo-local storage paths such as
`my-app/data/` or `my-app/.desktop-dev/`. Current desktop data lives under the
visible Lunery profile (`~/.lunerylab/studio` or `~/.lunerylab/studio-dev`).
Leftover local copies of those legacy dirs may be deleted.

## Documentation Maintenance

- Keep source rules in `/spec`; do not edit them during routine docs cleanup.
- Keep system and operational docs in `/docs`.
- Keep fresh-machine run instructions in `docs/DEV_SETUP.md`; link from
  root README, `my-app/README.md`, and `.github/CONTRIBUTING.md`.
- Keep transitive dependency override rationale in
  [PNPM_OVERRIDES.md](PNPM_OVERRIDES.md); `my-app/pnpm-workspace.yaml` is the
  authoritative pin list.
- Keep historical audit/plan files out of the repo unless they are explicitly
  referenced by active docs or code.
- Use relative links inside repository docs.
