# Cleanup Exemptions Ledger

Updated: 2026-07-21 (agent runtime rename; dead-code-and-docs-cleanup-loop, round 2).

Knip / filename scans are candidate generators only. Items below were reviewed
and must not be re-proposed as dead without new evidence.

## CONFIG snapshot

```yaml
APP_ROOT:        my-app
DEFAULT_BRANCH:  main
ENTRYPOINTS:     app/** (pages+api), src-tauri/**, scripts/**, vitest, package.json scripts
PUBLIC_API:      none  # private app; not a published library
DOWNSTREAM:      ""    # no known external consumers
BUILD_CMD:       pnpm build
TEST_CMD:        pnpm test:unit
TYPECHECK_CMD:   pnpm typecheck
LINT_CMD:        pnpm lint
DOCS_BUILD_CMD:  ""
FULL_GATE_CMD:   pnpm verify
DEAD_CODE_TOOL:  pnpm dlx knip@5
IMPACT_TOOL:     grep+callgraph (GitNexus MCP unavailable this session)
DOCS_ROOT:       docs/, /spec, README*, NOTICE/LICENSE, docs/adr, docs/hygiene
QUARANTINE_DIR:  .trash/
ARCH_SWAPS:      former versioned agent directory→runtime/ (done); ToolLoopAgent→streamText (policy); legacy profile paths→~/.lunerylab; capability-router→runtime-supply
PRE_LAUNCH:      true
SECURITY_KEEPLIST: desktop bridge auth; endpoint validation; file/path containment; destructive-action confirmation; no-default-model; PGlite baseline init
```

## Hard keep (project appendix)

- `my-app/engine/licenses/**`, NOTICE, THIRD_PARTY_NOTICES, LICENSE
- Tauri sidecar fetch/bundle scripts and `desktop-runtime-server.mjs`
- `@electric-sql/pglite`, `@electric-sql/pglite-socket` (spawned Node runtime + packaging copy)
- Live design-system modules: `grammar/*`, `shell/` (content-frame)
- Surface ownership docs under `docs/design/surfaces/*`
- ADR `docs/adr/0001-no-auto-update.md`
- `docs/PNPM_OVERRIDES.md` (unique override decision notes; yaml is pin source)

## Exemptions (alive / false positive)

| Candidate | Why KEEP |
| --- | --- |
| `scripts/desktop-runtime-server.mjs` | Spawned by Tauri + desktop-next-dev; bundled by desktop-bundle-assets; packaging tests |
| `@electric-sql/pglite` / `@electric-sql/pglite-socket` | Imported only by desktop-runtime-server; copied into appOut |
| `components/design-system/shell/index.ts` | Imported by app-shell + console loading for content-frame classes |
| shadcn unused sub-exports (DialogTrigger, etc.) | Design-system completeness / future composition; not proven theater |
| Model catalog `compatibility` / `legacy` lifecycle | Product policy, not dead shim |
| DB archive-on-incompatible in desktop-runtime-server | Current local safety valve |
| `docs/PNPM_OVERRIDES.md` | Linked from OPERATIONS; unique override rationale |

## Permanently deleted (round 2, after dual skeptic)

Recoverable via git history (`e8be661`, `0028e6a`, then this round's delete commit).
`lunaSurfaces` owner/route/role rows were copied into `docs/design/surfaces/*`
before deleting the TS registry.

| Former path | Why deleted |
| --- | --- |
| `.trash/ui/avatar.tsx` | Zero product consumers; not ui:check-pinned |
| `.trash/design-system/surface-shell.tsx` | Zero consumers; content-frame covers layout |
| `.trash/design-system/index.ts` | Unused root barrel; deep imports used instead |
| `.trash/design-system/primitives/index.ts` | Unused re-export facade |
| `.trash/design-system/assistant/index.ts` | Unused; studio/agent-chat is the live boundary |
| `.trash/design-system/surfaces/index.ts` | Unused TS registry; docs/design/surfaces owns contracts |

## Refuted / deferred

| Candidate | Disposition | Notes |
| --- | --- | --- |
| Showcase surface claim in UI_FRAMEWORK_STACK | Doc fixed | Removed from production surface list |
| `.ai/loops/design-invariants.md` references | Doc/gate renamed | Ledger gone; invariants live in UI_FRAMEWORK_STACK + ui:check |
| Legacy storage env prefix rename | Done | Renamed to `LUNERY_MEDIA_DIR` / `LUNERY_MAX_UPLOAD_BYTES_PER_FILE`; removed fixed per-user storage quota |
| Former versioned agent directory rename | Done | Renamed to `lib/server/agent/runtime/**`; entry `runAgent`; kept `runtime/` boundary (not flattened into `agent/`) to avoid outer request/runtime type collisions |
| Former web workspace API escape hatch | Removed | Desktop-local convergence: local FS media only; workspace APIs desktop-gated |
| Settings "Cost/local-first mode" doc claim | Done | Removed from settings surface contract; Required Structure matches current product |
