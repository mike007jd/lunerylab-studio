# Lunery Lab

Lunery Lab is a local-first AI creative Studio for images, video, and canvas workflows. The active product in this repo is `my-app`.

## Run locally (humans + coding agents)

Studio is the desktop app. From a fresh machine:

```bash
cd my-app
pnpm install
cp .env.example .env.local
pnpm prisma:generate
pnpm desktop:dev
```

Requirements: Node.js `>=22.23.1`, pnpm `>=10`, Rust (for Tauri). Desktop uses
embedded PGlite — no external Postgres. Full steps, pitfalls, and verify
commands: [docs/DEV_SETUP.md](docs/DEV_SETUP.md).

There is no supported browser/web product entrypoint in this repository. The
public website is maintained separately from the desktop application.

## Workspace Structure

```text
lunerylab-studio/
├── my-app/            # Lunery Lab Studio + Tauri desktop shell
├── docs/              # System, feature, operations, design, ADR, and hygiene docs
└── spec/              # Project rules and quality standards
```

## Active App

`my-app` is the desktop Studio. Marketing, download, legal, showcase, SEO, and
website deployment are maintained separately.

- Next.js 16 App Router
- Tauri 2 desktop shell
- TypeScript
- Tailwind CSS 4 + shadcn/ui
- Framer Motion
- Prisma with PostgreSQL
- Local-first / BYOK desktop direction; Vercel AI SDK is allowed as a library, but Vercel AI Gateway is not a target service
- No account / auth layer — single-user, account-less, MIT open-source

What exists in code:

- Studio workflow for image and video generation, gated to desktop runtime by default
- Canvas editing and asset management flows
- Desktop runtime settings for BYOK providers, local runtimes, and local model stores
- Image and video model pickers are runtime-fed: local models first, explicit BYOK provider model IDs second, no static platform-managed recommendation list
- Model/provider examples in UI are source-linked and expire after verification; stale rows are marked compatibility/legacy instead of recommended
- Runtime setup routes through desktop settings: local models first, BYOK providers second, no platform-managed credits
- English, Simplified Chinese, and Traditional Chinese UI

## Your data

Packaged Studio stores its workspace under `~/.lunerylab/studio`; local desktop
development uses `~/.lunerylab/studio-dev`. Downloaded model files can consume
tens of gigabytes. Use **Settings → Workspace Data** to back up or restore the
workspace. To uninstall completely, remove the application and then delete the
`~/.lunerylab` directory.

## Distribution and downloads

- Public installers are published on this repository's [Releases](../../releases) page.
- macOS Apple Silicon: `Lunery-Lab-Studio-macOS-arm64.dmg`
- Windows x64: `Lunery-Lab-Studio-Windows-x64.exe` currently uses CPU-only
  inference. Windows GPU acceleration is on the roadmap.

Implementation entry points:

- run on a fresh machine: [docs/DEV_SETUP.md](docs/DEV_SETUP.md)
- app notes: [my-app/README.md](my-app/README.md)
- system map: [docs/SYSTEM_OVERVIEW.md](docs/SYSTEM_OVERVIEW.md)
- feature reference: [docs/features/README.md](docs/features/README.md)
- operations and release readiness: [docs/OPERATIONS.md](docs/OPERATIONS.md)
- contributing: [.github/CONTRIBUTING.md](.github/CONTRIBUTING.md)
- engineering and design rules: [spec](spec)

## Repo Conventions

Project conventions live in `spec/`:

- [spec/AI_RUNTIME.md](spec/AI_RUNTIME.md)
- [spec/ENGINEERING_RULES.md](spec/ENGINEERING_RULES.md)
- [spec/DESIGN_RULES.md](spec/DESIGN_RULES.md)
- [spec/UX_RULES.md](spec/UX_RULES.md)
- [spec/PROJECT_CONSTITUTION.md](spec/PROJECT_CONSTITUTION.md)

Use the app-level README for setup basics. Use `/docs` for the maintained
system map, feature reference, operations checklist, design notes, ADRs, and
hygiene notes.

## License

This repository is licensed under MIT. See [LICENSE](LICENSE).
