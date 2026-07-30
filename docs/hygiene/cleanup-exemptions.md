# Cleanup Exemptions

Reviewed 2026-07-30. Static unused-code tools and filename scans generate
candidates; they do not prove that a file is dead.

## Always Preserve

- `LICENSE`, `NOTICE`, `THIRD_PARTY_NOTICES.md`, and `my-app/engine/licenses`
- Tauri sidecar fetch/bundle scripts and `desktop-runtime-server.mjs`
- desktop bridge auth, endpoint validation, path containment, destructive-action
  confirmation, explicit model selection, and PGlite baseline initialization
- `docs/adr`, `docs/design/surfaces`, and `docs/PNPM_OVERRIDES.md`

## Refuted Candidates

| Candidate | Survival evidence |
| --- | --- |
| `@electric-sql/pglite` and `@electric-sql/pglite-socket` | Desktop runtime imports and packages them. |
| `components/design-system/grammar` and `shell` | Live token, motion, and layout imports. |
| Unused shadcn sub-exports | Local primitive composition surface; no zero-reference file proved dead. |
| Model lifecycle values `compatibility` and `legacy` | Current catalog policy, not state migration. |
| Database archive on incompatible baseline | Current local-data recovery boundary. |
| `WEB_WORKSPACE_ROUTES` retired route names | Browser deny-list, not live pages. |
| `docs/PNPM_OVERRIDES.md` | Unique security rationale and atomic patch exit criteria. |
| `src-tauri/target`, `node_modules`, `.env.local`, `engine` | Intentional local build, dependency, secret, and runtime state. |

## Completed Convergence

Recoverable from Git history:

- Removed unused design-system barrels and the TypeScript surface registry after
  preserving live owner/route/state contracts in `docs/design/surfaces`.
- Merged the hidden Luna DNA brief and duplicate UI framework guide into
  `spec/DESIGN_RULES.md` and `spec/UX_RULES.md`.
- Retired repo-local and opaque OS profile paths; the visible Lunery profile is
  the only runtime contract.
- Removed post-PR17 type-only candidates proven unused by static, dynamic,
  package, history, and gate searches; executable surfaces and existing
  exemptions remain unchanged.

Reopen an exemption only when new call-graph, build, runtime, or product evidence
shows its status changed.
