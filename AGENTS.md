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

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus (4924 symbols, 13571 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely. Resolve the current index name with `list_repos`; do not hardcode a legacy repository name.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "main"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/{current-index}/context` | Codebase overview, check index freshness |
| `gitnexus://repo/{current-index}/clusters` | All functional areas |
| `gitnexus://repo/{current-index}/processes` | All execution flows |
| `gitnexus://repo/{current-index}/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
