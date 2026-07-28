# Studio Application

This directory contains the Tauri desktop product and its private Next.js
runtime. It is not a supported browser application.

## Start

```bash
pnpm install
cp .env.example .env.local
pnpm prisma:generate
pnpm desktop:dev
```

## Verify

```bash
pnpm verify
pnpm build
```

Desktop development uses PGlite under `~/.lunerylab/studio-dev`; keep
`DATABASE_URL` empty. See [Developer Setup](../docs/DEV_SETUP.md) for conditional
desktop/Rust gates and [the documentation map](../docs/README.md) for the
architecture, features, design, and release contracts.
