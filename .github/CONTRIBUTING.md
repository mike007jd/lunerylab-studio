# Contributing to Lunery Lab

Lunery Lab is a local-first AI creative Studio. This repository owns the Tauri
desktop app; the public website and its deployment are maintained separately.

## Setup

Follow [docs/DEV_SETUP.md](../docs/DEV_SETUP.md). Short version:

Requirements:

- Node.js 22.23.1 or newer
- pnpm 10 or newer
- Rust toolchain for desktop work

Install and run Studio (preferred):

```bash
cd my-app
pnpm install
cp .env.example .env.local
pnpm prisma:generate
pnpm desktop:dev
```

## Project Rules

Read [`spec`](../spec) before broad product or architecture changes.

Keep the product account-less, local-first, BYOK-capable, and free/open-source.
Do not add billing, credits, license gates, team plans, or online Studio
behavior.

## Verification

Before submitting a change:

```bash
cd my-app
pnpm verify
pnpm build
```

Add the conditional desktop/Rust gates from
[Developer Setup](../docs/DEV_SETUP.md). Verify behavior and UI in the current
Tauri build, not a browser or stale installed app.
