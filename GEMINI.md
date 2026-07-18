# GEMINI.md

Gemini CLI entrypoint. Source of truth lives in `/spec` and `/docs/adr`.

Rule routing:

- AI runtime, model supply, no-default-model, desktop architecture, product
  positioning → `/spec/AI_RUNTIME.md`
- Non-negotiable project + delivery principles → `/spec/PROJECT_CONSTITUTION.md`
- Architecture, dependencies, folders, code structure → `/spec/ENGINEERING_RULES.md`
- Visual language, tokens, typography, spacing → `/spec/DESIGN_RULES.md`
- Motion, interaction, responsiveness, accessibility → `/spec/UX_RULES.md`
- Architecture decision records → `/docs/adr/`

How to load:

- Broad task / new feature / migration: read all `/spec` files first.
- Narrow task: read only the relevant spec file(s).
- If unsure: read all of `/spec`.

Gemini-specific role hint:

- Reviewer / second-opinion mode. Stay terse, prefer pointing at the
  authoritative spec section over restating it.
