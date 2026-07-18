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

Read the source-of-truth specs before broad product or architecture changes:

- `spec/AI_RUNTIME.md`
- `spec/PROJECT_CONSTITUTION.md`
- `spec/ENGINEERING_RULES.md`
- `spec/DESIGN_RULES.md`
- `spec/UX_RULES.md`

Keep the product account-less, local-first, BYOK-capable, and free/open-source.
Do not add billing, credits, license gates, team plans, or online Studio
behavior.

## Verification

Before submitting a change:

```bash
cd my-app
pnpm run lint
pnpm run typecheck
pnpm run build
```

For UI work, also run:

```bash
pnpm run ui:check
```

Verify the affected flow directly in the live product surface when behavior or
UI changed.
