<p align="center">
  <img src="my-app/src-tauri/icons/icon.png" width="136" alt="Lunery Lab Studio crescent-moon icon" />
</p>

<h1 align="center">Lunery Lab Studio</h1>

<p align="center">
  <strong>Local-first AI creative Studio</strong><br />
  Create, refine, and organize images and video without a required Lunery account.
</p>

<p align="center">
  <a href="#download">Download the desktop app</a> ·
  <a href="#run-from-source">Run from source</a> ·
  <a href="#documentation">Documentation</a>
</p>

<p align="center">
  <img src=".github/readme/lunery-studio-overview.png" alt="Illustrated Lunery Lab Studio creative overview with a pixel crescent moon and three art fragments" width="100%" />
</p>

Lunery Lab Studio is a desktop workspace for taking a visual idea from prompt
and reference through generation, refinement, and a durable local library. Run
Local AI when it suits the machine, or connect a cloud service you already use.
There is no required account, hosted workspace, credit system, or
platform-owned model gateway in the middle.

## A creative room, not a model dashboard

| Find the direction | Carry the work forward | Finish in your own library |
| --- | --- | --- |
| Turn a prompt and reference images into an image or video. Set the style, aspect ratio, count, or batch where the idea starts. | Create locally or with the connection and exact model you chose. Send a result to Canvas, then reuse it as a reference when the next iteration needs it. | Keep projects, generated media, canvases, settings, and downloaded models on your machine, ready to reopen and develop. |

Setup stays subordinate to the work. When you need it, Settings can recommend a
local image model for the computer and let you add an optional cloud connection
without passing its key through a platform gateway.

<p align="center">
  <img src=".github/readme/settings-models-and-keys.jpeg" alt="Lunery Lab Studio showing a ready local image model and an optional cloud connection whose key stays on the computer" width="100%" />
</p>

## Yours by design

- **Local by default.** Projects, media, canvases, settings, and downloaded
  models live in a visible folder on your machine. Provider keys stay in the OS
  keychain.
- **Compute is your choice.** Connect a local engine, discover compatible
  models, or add an optional cloud API connection only when it helps the work.
- **No hidden model decision.** Studio never silently selects a generation
  model for you, and it never places a platform service between you and a
  provider connection you configured.

## Download

**[Get the latest desktop release](https://github.com/mike007jd/lunerylab-studio/releases/latest)**

Public builds are currently available for Apple Silicon macOS:

- macOS — `Lunery-Lab-Studio-macOS-arm64.dmg`, signed and notarized

Windows distribution is paused until its profile filesystem and local-engine
paths have reparse-point-safe implementations and dedicated acceptance coverage.

Every release includes `SHA256SUMS.txt` so the installer can be verified before
opening it. Studio stores its workspace at `~/.lunerylab/studio`; local models
may need tens of gigabytes. **Settings → Workspace Data** backs up projects,
images, canvases, and settings. Downloaded models and OS-keychain secrets are
intentionally excluded.

## Run from source

```bash
git clone https://github.com/mike007jd/lunerylab-studio.git
cd lunerylab-studio/my-app
corepack enable
pnpm install
cp .env.example .env.local
pnpm prisma:generate
pnpm desktop:dev
```

Use Node.js `24.18.0` (pinned in `my-app/.node-version`), pnpm `>=10`, and Rust for the Tauri desktop shell.
Desktop uses embedded PGlite, so no external Postgres is required. The complete
setup, validation, and local-data guidance is in
[Developer Setup](docs/DEV_SETUP.md).

## Documentation

| Need | Start here |
| --- | --- |
| Set up, run, and validate Studio | [docs/DEV_SETUP.md](docs/DEV_SETUP.md) |
| Run human desktop acceptance | [docs/QA_MANUAL.md](docs/QA_MANUAL.md) |
| Find the engineering documentation | [docs/README.md](docs/README.md) |
| Understand product and engineering rules | [spec](spec) |
| Contribute a change | [.github/CONTRIBUTING.md](.github/CONTRIBUTING.md) |

## License

Licensed under the Apache License 2.0. See [LICENSE](LICENSE) and
[NOTICE](NOTICE).
