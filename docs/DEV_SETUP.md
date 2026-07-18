# Developer Setup

Audience: humans and coding agents on a fresh checkout. Goal: get the real
Studio running with the fewest steps.

## Product shape (read this first)

| Surface | Command | What you get |
| --- | --- | --- |
| Desktop Studio (preferred) | `pnpm desktop:dev` | Tauri window + local Next server + PGlite. Real product. |

- Active app directory: `my-app/`
- Desktop does **not** need an external PostgreSQL. Dev injects PGlite and sets
  `DATABASE_URL` for you.
- Local desktop data lives under `~/.lunerylab/studio-dev/`
  (`config/`, `data/pglite/`, `data/media/`, `models/`, `logs/`, `runtime/`).
- Do not use legacy paths such as
  `~/Library/Application Support/com.lunerylab.studio` or repo-local
  `.desktop-dev`.

## Prerequisites

| Tool | Requirement |
| --- | --- |
| Node.js | `>=22.23.1` (CI uses `22.23.1`) |
| pnpm | `>=10` (repo pins `pnpm@10.15.1` via `packageManager`) |
| Rust | Stable toolchain (`rustup`), needed for Tauri |
| macOS | Xcode Command Line Tools; Apple Silicon is the primary desktop target |
| Windows | MSVC build tools + WebView2; x64 target |

Optional but useful: `pnpm desktop:info` (Tauri doctor) after install.

## Setup (once per machine)

```bash
cd my-app
pnpm install
cp .env.example .env.local
pnpm prisma:generate
```

For desktop Studio, `.env.local` can keep `DATABASE_URL` empty. Desktop runtime
starts PGlite and overrides `DATABASE_URL`. Copying `.env.example` keeps
optional runtime overrides documented.

Do not set `ECOM_ENABLE_WEB_WORKSPACE_API=1` unless you intentionally want the
dangerous web workspace escape hatch. Desktop never needs it.

## Run Studio (preferred)

```bash
cd my-app
pnpm desktop:dev
```

What this does:

1. Starts Tauri (`@tauri-apps/cli`)
2. Starts the private UI runtime on `127.0.0.1:3000` with `LUNERY_DESKTOP=1`
3. Boots embedded PGlite under `~/.lunerylab/studio-dev/data/pglite`
4. Opens `/studio` in the desktop WebView

Success check:

- A Lunery Lab Studio window opens on `/studio`
- Settings → Providers / local runtime status loads
- Profile dirs exist under `~/.lunerylab/studio-dev`

The private UI runtime is not a supported browser product entrypoint; run it
through Tauri so the bridge, profile, lifecycle, and recovery behavior match the
shipped application.

## Verify without the GUI

From `my-app/`:

```bash
pnpm typecheck
pnpm lint
pnpm test:unit
pnpm ui:check
```

Add when relevant:

```bash
pnpm desktop:check          # desktop scripts / Tauri / bridge
pnpm ai:freshness           # model catalog freshness
cargo test                  # from my-app/src-tauri when Rust changes
pnpm build                  # full Next standalone build (heavier)
```

Convenience: `pnpm verify` runs typecheck + lint + unit + ui:check + ai:freshness.

For a local macOS installer, run `pnpm desktop:build:local`. It produces a fresh
unsigned `.app`, a verified headless DMG, and a layout evidence PNG under
`my-app/src-tauri/target/release/bundle/`. Use `pnpm desktop:build` for the
platform release wrapper; when all Apple release credentials are present it
enforces the full signed and notarized artifact chain.

## Common pitfalls

- Working from the repo root instead of `my-app/` — all app scripts run in
  `my-app/`.
- Expecting the public website in this repo — it is maintained separately.
- Installing an old `/Applications/Lunery Lab Studio.app` and validating that
  instead of the checkout. After code changes, use `pnpm desktop:dev` (or a
  fresh local build) and confirm the process path belongs to this repo.
- Setting `ECOM_STORAGE_DIR` to a relative path — it must be absolute when set.
- Hunting Postgres for desktop — not required; PGlite is the desktop database.
- Reading/writing legacy app-data locations — use `~/.lunerylab/studio-dev` in
  local desktop dev.
- Reusing a disposable prelaunch profile after the database baseline changes.
  Desktop startup archives the incompatible PGlite directory under
  `data/recovery/` and creates the current baseline without touching `config/`,
  `models/`, or media.

## Where to read next

| Need | Doc |
| --- | --- |
| Architecture map | [SYSTEM_OVERVIEW.md](SYSTEM_OVERVIEW.md) |
| Feature inventory | [features/README.md](features/README.md) |
| Product / runtime rules | [`../spec`](../spec) |
| Release / signing (maintainers) | [OPERATIONS.md](OPERATIONS.md) |
| Contribute checklist | [../.github/CONTRIBUTING.md](../.github/CONTRIBUTING.md) |
