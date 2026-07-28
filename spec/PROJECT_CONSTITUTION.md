# Project Constitution

## Product Stage

Lunery Lab Studio is prelaunch. There are no user-data or compatibility
contracts to preserve. Converge on the current product shape; do not add legacy
readers, migrations, rollout flags, or speculative fallback paths.

Keep the real safety boundaries:

- desktop bridge authentication and endpoint validation;
- file and path containment;
- confirmation for destructive actions;
- explicit model selection with no silent default;
- the current PGlite initialization baseline.

## Delivery

- Ship a complete feature boundary, not a quality-tier phase or placeholder.
- Keep scope intentional. Split oversized work by independently useful feature,
  never by "basic now, quality later."
- Reuse current code before adding an abstraction or dependency.
- Prefer the simplest readable implementation that satisfies the product
  contract.
- Resolve reversible implementation decisions autonomously. Escalate only
  irreversible, paid, production-data, or account-binding actions.
- Validate with the task-relevant gates in `docs/DEV_SETUP.md` and the live
  product surface when behavior or UI changes.

## Documentation

- `/spec` owns product and engineering rules; `/docs/adr` owns durable
  architecture decisions; `/docs` owns setup, system, and operations guidance.
- Engineering and design documentation is concise English. Link to a source of
  truth instead of copying it.
- Do not edit agent entry files or `/spec` during ambient cleanup. Explicit
  documentation tasks may update them with full validation.
