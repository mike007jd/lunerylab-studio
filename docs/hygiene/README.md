# Hygiene Notes

This folder holds public integration and cleanup governance notes. The source
of truth still lives in `/spec`; do not duplicate or weaken those rules here.

- `sdk-integration-governance.md`: current SDK integration boundaries and audit
  guardrails.
- Cleanup policy lives in `../OPERATIONS.md`.

## Cleanup Rules

- Verify current references before deleting docs or source files.
- Treat `knip` and filename scans as candidate generators, not proof.
- Use `pnpm desktop:clean` for stale desktop/build artifacts.
- Do not blanket-delete ignored files: `.env.local`, `node_modules`, Tauri
  target caches, local engines, uploads, and generated media are local working
  state.
