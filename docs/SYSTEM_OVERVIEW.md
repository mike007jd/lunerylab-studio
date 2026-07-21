# System Overview

Checked on 2026-06-18 against the current repository.

This document is the operating map for the whole codebase. Project rules remain
under `/spec`; this file explains how the current system is assembled.

## Product Shape

Lunery Lab is a local-first AI creative Studio.

- Public web: maintained and deployed separately from this desktop repository.
- Desktop app: the real Studio, running a local Next.js server inside Tauri 2.
- Account model: single implicit local owner, no hosted account, no billing, no
  credits, no license key, no team tier.
- Runtime priority: local/Hugging Face first, BYOK second, optional cloud only
  when explicitly wired and never as a silent default.

## Repository Map

| Path | Owns |
| --- | --- |
| `spec/` | Source-of-truth rules for AI runtime, engineering, design, UX, and delivery. |
| `docs/adr/` | Architecture decision records. |
| `docs/design/` | Surface design notes for Studio, Canvas, Library, and Settings. |
| `docs/hygiene/` | Public integration and cleanup governance notes. |
| `my-app/app/` | Next.js App Router pages and API route handlers. |
| `my-app/components/` | Surface components, design system wrappers, and shadcn primitives. |
| `my-app/lib/` | Client/server helpers, model catalogs, runtime routing, storage, i18n, and DTOs. |
| `my-app/prisma/` | PostgreSQL schema and current desktop database baseline. |
| `my-app/src-tauri/` | Tauri 2 desktop shell and Rust bridge/runtime commands. |
| `my-app/scripts/` | Build, release, model fetch, UI framework, desktop, and AI freshness gates. |
| `my-app/public/` | Desktop sample and template assets bundled with Studio. |

## Runtime Architecture

### Desktop Runtime

- Tauri launches its private UI runtime through `pnpm desktop:runtime:dev` in development.
- Release builds run `pnpm desktop:clean && pnpm build && pnpm desktop:prepare`.
- The desktop bundle embeds `desktop-server` and `engine` resources.
- Next API routes talk to the Rust bridge through `LUNERY_DESKTOP_BRIDGE_URL`
  and `LUNERY_DESKTOP_BRIDGE_TOKEN`.
- There is no supported browser Studio; the loopback server is a desktop-only
  implementation detail enabled by `LUNERY_DESKTOP=1`.
- `my-app/proxy.ts` guards desktop-only routes, APIs, and CSP nonces.

### Data Model

Prisma models:

- `User` and `UserSettings`: implicit local workspace owner and local
  preferences.
- `Project`: Studio project grouping.
- `GenerationJob`: image/video/3D job records and idempotency.
- `Asset`: generated/reference media with modality, tags, favorites, and notes.
- `ReferenceSet`: reusable project-scoped creative context bundles.
- `CanvasSession`, `CanvasLayer`, `CanvasSnapshot`: persistent canvas state and
  rollback points.
- `AppState`: singleton platform config placeholder.

### Storage

- Media storage is local filesystem only. It writes to the visible Lunery
  profile media directory by default; `LUNERY_MEDIA_DIR` is an absolute-path
  override.
- Storage paths are limited to `uploads/<file>`, `generated/<file>`, and their
  project-scoped `bucket/<projectId>/<file>` form.
- `my-app/data/uploads` and `my-app/data/generated` are legacy migration/
  compatibility artifacts, not source files or new defaults.

### AI Runtime

- `lib/server/runtime-supply.ts` decides local vs BYOK runtime availability.
- `lib/server/image-generate.ts` routes image generation across local engines
  and BYOK providers.
- `lib/server/byok-llm.ts` uses AI SDK language models for text-capable BYOK
  providers.
- `lib/server/byok-image-adapters.ts` uses AI SDK image models for OpenAI and
  OpenAI-compatible image calls, while Fal/Replicate keep provider queue/poll
  clients.
- `lib/server/video-runtime.ts`, `lib/server/byok-video.ts`, and
  `lib/video-models.ts` own video provider behavior.
- `lib/server/agent/v2/` owns the canvas agent loop, tools, snapshots, and
  artifact aggregation.

## Security And Boundaries

- State-changing API routes require same-origin `Origin` or `Referer`.
- CSP is centralized in `lib/csp.ts` and stamped with per-request nonces.
- Desktop bridge routes must pass `requireDesktopBridge`.
- BYOK credentials are read through server-side secret helpers; UI should only
  store provider metadata and status.
- `resolveStoragePath` rejects absolute paths and path traversal.

## Verification Entry Points

Run from `my-app/`:

- `pnpm typecheck`
- `pnpm lint`
- `pnpm test:unit`
- `pnpm build`
- `pnpm ui:check`
- `pnpm ai:freshness`
- `pnpm desktop:check` when desktop/Tauri/runtime files change
- `cargo test` under `my-app/src-tauri` when Rust files change
