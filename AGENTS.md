# Repository Agent Guide

Shared entrypoint for coding agents. The source of truth is `/spec` and
`/docs/adr`; do not duplicate those rules here.

## Read Map

| Task | Read first |
| --- | --- |
| Fresh setup or local run | `/docs/DEV_SETUP.md` |
| Project stage and delivery | `/spec/PROJECT_CONSTITUTION.md` |
| AI, model supply, product runtime | `/spec/AI_RUNTIME.md` |
| Architecture, dependencies, code layout | `/spec/ENGINEERING_RULES.md` |
| Visual or interaction work | `/spec/DESIGN_RULES.md` and `/spec/UX_RULES.md` |
| Release or packaging | `/docs/OPERATIONS.md` |
| Broad product change | All files in `/spec` |

## Current Contract

- The product is prelaunch. Do not preserve legacy state with migrations,
  compatibility readers, old API shims, fallback branches, or rollout flags.
- Preserve the real boundaries: desktop bridge auth, endpoint validation,
  file/path containment, destructive-action confirmation, explicit model
  selection, and the current PGlite baseline.
- Desktop files use only the resolved Lunery profile described in
  `/spec/AI_RUNTIME.md`.

## Delivery

- Own implementation and QA. Keep diffs focused, complete the feature boundary,
  and run the task-relevant gates from `/docs/DEV_SETUP.md`.
- Run app commands from `my-app/`. Use `pnpm desktop:dev`, never plain
  `pnpm dev`.
- Before desktop GUI validation, run the clean build path and prove the tested
  window PID and executable belong to the current checkout or new artifact.
  Close stale `/Applications/Lunery Lab Studio.app` processes.
- Engineering and design documentation must be concise English.
