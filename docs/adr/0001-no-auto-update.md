# ADR 0001 — Desktop auto-update: deferred

- Status: Accepted
- Date: 2026-05-29
- Decision owner: maintainer (single)
- Drivers: implement `tauri-plugin-updater` OR explicitly document no
  auto-update

## Context

Lunery Lab Studio is the Tauri 2 desktop shell distributed through the sibling
marketing website. The product is:

- Free, Apache-2.0 open-source, no monetization layer.
- Single-user, **account-less** — no backend identity, no entitlement service.
- Distributed via GitHub Releases (macOS `.dmg` + `.app` and Windows NSIS
  `.exe` artifacts built by `.github/workflows/desktop-release.yml`; no Linux
  build).

The code-review identified that the Tauri config does not wire
`tauri-plugin-updater`, so the desktop installs do not check for or fetch new
versions on their own.

## Options

### Option A — Install `tauri-plugin-updater`

- Requires a publicly reachable update endpoint (Tauri's updater fetches a
  JSON manifest with version, signature, download URLs).
- Requires a long-lived release-signing keypair (Tauri's `--private-key`),
  kept in CI secrets, used to sign every release artifact.
- Requires either GitHub Pages, a Vercel route, or a third-party update host
  (e.g. Cloudflare R2 + a static manifest) — i.e. infrastructure the project
  does not currently run for the desktop binary.
- Adds attack surface: a leaked signing key silently pushes malware to every
  installed copy. A compromised update host can push downgrade attacks unless
  we also implement version-pinning in the manifest.
- Failure mode if neglected: stale manifest, broken downloads, users see
  install-prompt errors on every launch — worse UX than no updater at all.

### Option B — No auto-update (chosen)

- Users download new versions from the GitHub Releases page.
- The sibling website's `/download` page links to fixed `releases/latest/download/<asset>` URLs
  (and to the Releases page itself); GitHub redirects those to the newest
  published build. No build-time tag rendering is involved.
- "Check for updates" is not surfaced in-app; the About panel links to the
  Releases page in the user's browser.
- No update server, no signing key beyond the existing macOS notarization +
  Windows code-signing cert, no per-release manifest publishing step.

## Decision

**Option B — no auto-update for the foreseeable future.**

Rationale:

1. **Infrastructure cost is permanent.** A free, account-less, single-user app
   should not require running an update server to remain functional.
2. **Compromise blast radius.** A signing-key leak in a no-monetization
   project has no balancing revenue to fund key rotation, incident response,
   or user notification. The "update prompt" channel is a worse silent
   attack vector than asking the user to revisit the Releases page.
3. **The release cadence is already low.** The desktop binary is rebuilt on
   each git tag; users who want the latest will check GitHub.
4. **Reversible.** If the project later acquires funding for an update host,
   we can wire `tauri-plugin-updater` without disrupting any user data on
   disk — the keychain entries, downloaded models, project DB all stay in
   `${app_data_dir}`.

## Consequences

- The desktop `tauri.conf.json` does **not** enable
  `plugins.updater` and **does not bundle the Updater public key**.
  Re-introducing it requires both this ADR being superseded and the
  infrastructure listed under Option A actually being stood up.
- README / sibling website `/download` page must continue to link the Releases page and the
  `releases/latest/download/<asset>` installers prominently so users can
  self-update.
- A future tag that ships a security fix MUST include a banner on the
  sibling marketing site (`/download`) and a `SECURITY.md` advisory — there is no
  in-app push channel.

## Reconsideration triggers

Re-open this ADR if:

- The project takes funding / monetization that can sustain an update host.
- A security-sensitive vulnerability ships in a Tauri-side dependency and we
  need an in-app push to migrate users off a vulnerable binary.
- User feedback shows the GitHub-Releases-only update path is the top
  friction point (i.e. the cost of *not* having auto-update exceeds the cost
  of running an update server).

Until then: no auto-update. Users update by re-downloading.
