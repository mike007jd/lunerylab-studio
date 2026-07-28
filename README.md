# Lunery Lab Studio

Lunery Lab is a local-first desktop workspace for image, video, canvas, and
asset workflows. The product lives in `my-app`; the public website is maintained
separately.

## Start

```bash
cd my-app
pnpm install
cp .env.example .env.local
pnpm prisma:generate
pnpm desktop:dev
```

Requirements: Node.js `>=22.23.1`, pnpm `>=10`, Rust (for Tauri). Desktop uses
embedded PGlite and needs no external Postgres. See
[Developer Setup](docs/DEV_SETUP.md) for the full workflow and verification
gates.

There is no supported browser Studio, account system, billing, credits, or
platform-funded model gateway.

## Data

Packaged Studio stores its workspace under `~/.lunerylab/studio`; local desktop
development uses `~/.lunerylab/studio-dev`. Downloaded model files can consume
tens of gigabytes. Use **Settings → Workspace Data** to back up or restore the
workspace. To uninstall completely, remove the application and then delete the
`~/.lunerylab` directory.

## Downloads

- [GitHub Releases](https://github.com/mike007jd/lunerylab-studio/releases)
- macOS Apple Silicon: `Lunery-Lab-Studio-macOS-arm64.dmg`
- Windows x64: `Lunery-Lab-Studio-Windows-x64.exe` (CPU inference)

## Documentation

| Need | Start here |
| --- | --- |
| Setup and validation | [docs/DEV_SETUP.md](docs/DEV_SETUP.md) |
| Documentation map | [docs/README.md](docs/README.md) |
| Product and engineering rules | [spec](spec) |
| Contribution checklist | [.github/CONTRIBUTING.md](.github/CONTRIBUTING.md) |

## License

This repository is licensed under the Apache License 2.0. See [LICENSE](LICENSE)
and [NOTICE](NOTICE).
