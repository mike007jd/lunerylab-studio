# AGENTS.md

Codex CLI entrypoint. Source of truth lives in `/spec` and `/docs/adr`.

Rule routing:

- AI runtime, model supply, no-default-model, desktop architecture, product
  positioning → `/spec/AI_RUNTIME.md`
- Non-negotiable project + delivery principles → `/spec/PROJECT_CONSTITUTION.md`
- Architecture, dependencies, folders, code structure → `/spec/ENGINEERING_RULES.md`
- Visual language, tokens, typography, spacing → `/spec/DESIGN_RULES.md`
- Motion, interaction, responsiveness, accessibility → `/spec/UX_RULES.md`
- Architecture decision records → `/docs/adr/`

How to load:

- Fresh machine / need the app running: read `/docs/DEV_SETUP.md` first, then
  run Studio with `cd my-app && pnpm desktop:dev` (not plain `pnpm dev`).
- Broad task / new feature / migration: read all `/spec` files first.
- Narrow task: read only the relevant spec file(s).
- If unsure: read all of `/spec`.

Project stage:

- This project is confirmed prelaunch. There are no real users, production
  data, or historical compatibility contracts to protect.
- Do not add migrations, compatibility layers, legacy config readers, old API
  shims, fallback branches, rollout flags, or minimal patch paths to preserve
  old local state. Collapse to the current clean product shape instead.
- Tests, fixtures, sample data, local generated data, stale plan docs, old
  scripts, deprecated UI entries, and unfinished planned-feature stubs may be
  deleted when they are not part of the current product shape.
- Keep only current safety/product boundaries: desktop bridge auth, endpoint
  validation, file/path containment, explicit destructive-action confirmation,
  no-default-model behavior, and the current local database baseline needed to
  initialize desktop PGlite.

Codex-specific role hint:

- Long-running engineering executor. Bias toward small, verified diffs and
  run lint + typecheck + build before reporting done.
- Desktop/app validation is never allowed against a stale installed app. After
  code changes, run the repo clean/build path first (`pnpm desktop:clean`,
  `pnpm build`, `pnpm desktop:prepare`, `pnpm desktop:check`; then
  `pnpm desktop:dev` or the requested packaging command as appropriate).
  Before any GUI validation, verify the target window's PID and executable path
  point to the current checkout or the newly built artifact; close stale
  `/Applications/Lunery Lab Studio.app` instances instead of interacting with
  them.
- Do not report desktop validation complete until both the clean build gates and
  the window/process identity prove the current build is the one being tested.
- Desktop-owned local files must use the visible Lunery profile, not opaque OS
  app-data defaults or repo-local scratch dirs. Packaged/current desktop uses
  `~/.lunerylab/studio`; local desktop dev uses `~/.lunerylab/studio-dev`.
  Expected subdirs are `config/`, `data/pglite/`, `data/media/`, `models/`,
  `logs/`, and `runtime/`. Do not read, migrate, or write legacy locations such
  as `~/Library/Application Support/com.lunerylab.studio`,
  `~/Library/Logs/com.lunerylab.studio`, `my-app/.desktop-dev`, `my-app/data`,
  or `~/.cache/lunerylab/models`. When validating desktop storage, check
  `/api/desktop-runtime/status`, Settings → Providers, and the actual
  filesystem under `~/.lunerylab`.
