# Operations And Release

Setup and routine validation live in [DEV_SETUP.md](DEV_SETUP.md). Run commands
from `my-app/`.

## Gates

```bash
pnpm verify
pnpm build
git diff --check
```

Add `pnpm desktop:check` for desktop/Tauri/build changes and `cargo test` from
`src-tauri` for Rust. UI and behavior changes require validation in the current
Tauri build.

## Build Commands

| Command | Purpose |
| --- | --- |
| `pnpm desktop:clean` | Remove generated desktop and Next outputs. |
| `pnpm desktop:build:local` | Build an unsigned macOS app and verified DMG for local QA. |
| `pnpm desktop:build` | Build the platform release artifact. |

The release build runs `desktop:clean`, `build`, and `desktop:prepare` before
Tauri packaging. The supported release target is Apple Silicon macOS and
produces a DMG. Windows packaging is disabled until its profile and local-engine
paths have reparse-point-safe implementations and release acceptance coverage.

## CI Release Contract

`.github/workflows/desktop-release.yml` is authoritative.

| Trigger/platform | Signing behavior | Publishes |
| --- | --- | --- |
| `v*` tag, macOS | Apple signing and notarization required; missing credentials fail closed. | Yes |
| Manual dispatch | Same build and signing rules as above. | No |

The workflow verifies tag/package/Tauri version parity, runs the shared
validation workflow, builds the macOS installer, and publishes its stable asset name
plus `SHA256SUMS.txt`.

macOS order:

1. Sign, notarize, and staple the app.
2. Build the DMG from that final app.
3. Sign, notarize, and staple the DMG.
4. Verify codesign, Gatekeeper, stapling, mounted layout, and `hdiutil`.

See the current [Tauri distribution guide](https://v2.tauri.app/distribute/)
for the platform requirements; the repository workflow remains the executable
contract.

## Release Configuration

macOS secrets:

- `APPLE_SIGNING_IDENTITY`
- `APPLE_ID`
- `APPLE_PASSWORD` (app-specific password)
- `APPLE_TEAM_ID`
- `APPLE_CERTIFICATE`
- `APPLE_CERTIFICATE_PASSWORD`

Actions variables:

- `SIGNING_CREDENTIAL_OWNER`
- `NOTARIZATION_CREDENTIAL_ROTATED_AT`

Apple credentials must have a named owner and a recorded rotation date no older
than 180 days. Rotate immediately after suspected exposure. Never store signing
secrets in the repository or logs.

`GITHUB_TOKEN` is supplied by Actions for source lookup and release publishing;
maintainers do not create a custom secret with that name.

## Release Acceptance

- Browser access to workspace routes redirects to the separate download site.
- `pnpm verify`, `pnpm build`, and applicable desktop/Rust gates pass.
- No billing, license, account, credit, or platform-funded model surface exists.
- BYOK content providers require an explicit model ID unless the operation has
  no model choice.
- Packaged resources come from a fresh clean build.
- Final artifacts match the stable names in the workflow and their published
  SHA-256 values.

## Cleanup

Use `pnpm desktop:clean` for generated application outputs. Remove reports,
screenshots, logs, and temporary files only after confirming they are not
tracked source, bundled assets, or user data.

Do not run blanket commands such as `git clean -fdX`. Preserve:

- `my-app/.env.local`
- `my-app/node_modules`
- `my-app/src-tauri/target`
- `my-app/engine`
- `~/.lunerylab/studio`
- `~/.lunerylab/studio-dev`

Retired repo-local and OS app-data paths are not runtime inputs. Current
desktop data lives only in the visible Lunery profile.

## Documentation Ownership

- Setup and gates: `DEV_SETUP.md`
- Rules: `/spec`
- Durable decisions: `/docs/adr`
- Override rationale: `PNPM_OVERRIDES.md`
- Historical plans and audit reports stay out of the repository.
