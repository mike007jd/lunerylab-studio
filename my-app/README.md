# Lunery Lab

Lunery Lab is the main product in this repository: a local-first AI visual creation workspace for image generation, video generation, canvas editing, reusable Studio task intents, and asset management.

## Current Stack

- Next.js 16 App Router
- Tauri 2 desktop shell
- React 19 + TypeScript
- Tailwind CSS 4 + shadcn/ui
- Framer Motion
- Prisma + PostgreSQL
- Local filesystem storage for uploaded and generated media
- Desktop-first Studio runtime with embedded local engines, BYOK, and local-model support

## Implemented Surfaces

- `/studio` - prompt-first generation workspace, available only when launched through the desktop runtime
- `/projects/[id]` - desktop-only project workspace surfaced from the Studio sidebar
- `/library` - projects, jobs, and assets
- `/canvas/[sessionId]` - desktop canvas editing
- `/settings` - desktop runtime, BYOK provider connections, local model status, and device language

## Run locally

Canonical steps for a fresh machine (humans + coding agents):
[../docs/DEV_SETUP.md](../docs/DEV_SETUP.md).

Preferred path — desktop Studio:

```bash
pnpm install
cp .env.example .env.local
pnpm prisma:generate
pnpm desktop:dev
```

Desktop uses embedded PGlite under `~/.lunerylab/studio-dev`. Leave
`DATABASE_URL` empty in `.env.local` for that path.

There is no browser/web product mode. Tauri owns startup and exposes the bundled
UI runtime only as a private loopback implementation detail. The public website
is maintained separately.

Environment template: [`.env.example`](.env.example).

## Validation

```bash
pnpm run lint
pnpm run typecheck
pnpm run test:unit
pnpm run ui:check
pnpm run build
pnpm run desktop:check
pnpm run ai:freshness
```

For rendered UI changes, also run the app locally and verify the affected surface in a browser at desktop and mobile widths.

## Release

Desktop installers are built from `.github/workflows/desktop-release.yml` on `v*` tags. Public launch assets are published from the clean releases-only repository `mike007jd/LuneryLab-Releases`, and the public download page links to stable GitHub Releases asset names:

- `Lunery-Lab-Studio-macOS-arm64.dmg`
- `Lunery-Lab-Studio-Windows-x64.exe`

## Product Notes

- The public website is distribution-only and must not expose online Studio or any Studio workspace route.
- The desktop direction is embedded local engines, BYOK providers, OpenAI-compatible endpoints, and Hugging Face/local-model support.
- The Studio has no account, paywall, activation, or platform-managed balance product surface.
- Project-wide rules live under [`../spec`](../spec).
- Runtime media storage uses the visible Lunery profile by default; `ECOM_STORAGE_DIR` is only an absolute-path override.

## Documentation Map

- [Developer setup (fresh machine)](../docs/DEV_SETUP.md)
- [System overview](../docs/SYSTEM_OVERVIEW.md)
- [Feature reference](../docs/features/README.md)
- [Operations and release readiness](../docs/OPERATIONS.md)
- [UI framework stack](../docs/UI_FRAMEWORK_STACK.md)
- [SDK integration governance](../docs/hygiene/sdk-integration-governance.md)
