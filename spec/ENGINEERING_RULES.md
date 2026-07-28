# Engineering Rules

This file describes the current repository, not greenfield defaults. Exact
versions live in `my-app/package.json` and `my-app/pnpm-lock.yaml`.

## Architecture

- `my-app/app`: Next.js routes and API handlers.
- `my-app/components`: feature surfaces and local UI primitives.
- `my-app/lib`: client/server contracts, runtime routing, storage, and i18n.
- `my-app/prisma`: schema and current desktop PGlite baseline.
- `my-app/src-tauri`: Tauri shell, bridge, secrets, and local runtime control.
- `my-app/scripts`: build, release, desktop, UI, license, and freshness gates.

The supported product is the Tauri desktop Studio. The loopback Next server is
an implementation detail, not a browser product.

## Implementation Rules

- Default to Server Components. Add `use client` only for interaction, browser
  APIs, or client hooks.
- Keep data and state near the route or feature that owns them. Use shared state
  only for current cross-surface needs.
- Reuse local shadcn primitives and existing feature components before adding
  abstractions.
- Keep server-only SDKs and credentials out of client modules.
- Route desktop operations through the existing bridge; do not create a second
  runtime or storage path.
- Treat `desktop-server`, `desktop-dist`, generated Prisma output, and Tauri
  targets as generated artifacts. Change their source or build scripts.
- New dependencies require a current need, an official-source check, license
  compatibility, and lockfile updates. Avoid beta or canary packages by default.
- Override rationale and removal criteria live in
  `docs/PNPM_OVERRIDES.md`.

## UI Boundary

- Tailwind CSS is the styling system; shadcn/ui supplies local primitives.
- Framer Motion is the only JavaScript motion library. Controlled CSS loading
  animation remains allowed.
- Use semantic tokens and the shared wrappers described in
  `DESIGN_RULES.md` and `UX_RULES.md`.
- Do not add a parallel component library, styling system, icon family, or
  assistant runtime.

## Security Boundary

Preserve desktop bridge authentication, same-origin mutation checks, CSP
nonces, endpoint validation, file/path containment, keychain-backed secrets,
destructive-action confirmation, and explicit model selection.

## Validation

Run from `my-app/`:

| Change | Required gates |
| --- | --- |
| Any code or docs | `pnpm verify && pnpm build` |
| UI | Above plus live Tauri validation |
| Desktop/Tauri/build scripts | Above plus `pnpm desktop:check` |
| Rust | Above plus `cargo test` in `src-tauri` |
| Model/provider catalog | Above; `pnpm ai:freshness` is already in `verify` |

Use the clean desktop build and process-identity procedure in
`docs/DEV_SETUP.md`; never validate a stale installed app.
