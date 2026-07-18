# Project Constitution

This repository follows an AI-first, full-speed development workflow.

We are AI-driven development. What used to take teams weeks takes us hours.
Do not think in phases, sprints, or multi-week roadmaps.
Think in sessions: one session, one production-ready deliverable.

## AI Development Manifesto

1. **Ship 1.0, not 0.1.** Every build targets production-grade completeness.
   No "MVP scaffolding to polish later". No throwaway prototypes. Build it right, build it once.
2. **No multi-phase fantasies.** There is no Phase 1 / Phase 2 / Phase 3.
   There is only: build the complete thing now. If it's too big for one session, split by feature boundary, not by quality tier.
3. **Go wide and deep in one pass.** AI can generate full-stack features end-to-end.
   Do not artificially constrain scope. If you can build the complete feature now, do it.
4. **Speed is the default.** Do not hedge, do not add "we might need this later" abstractions.
   Build exactly what is needed, at production quality, right now.
5. **Validate as you go, not at the end.** Run lint, typecheck, build after each major piece.
   But do not let validation become a bottleneck — fix and move on immediately.

## Operating principles

1. Build production-grade from the first pass. No half-measures, no "fix later" debt.
2. Reuse before creating new abstractions.
3. Keep the stack minimal and coherent.
4. Prefer clear, readable code over clever architecture.
5. Validate continuously — lint, typecheck, build after each feature lands.
6. Do not modify project rules unless explicitly requested.

## Default stack direction

For new web projects, the default direction is:

- Next.js App Router
- TypeScript
- Tailwind CSS
- shadcn/ui
- Lucide
- Framer Motion

For existing projects:

- respect the current repo setup
- do not perform unsolicited migrations
- do not switch routers or major libraries unless requested

## Quality bar

A feature is not done when it "basically works".
A feature is done when it is production-ready: coherent UI, passing validation, complete functionality.

Completion standard:

- the code is clear and maintainable
- the UI respects design and UX rules
- lint passes
- typecheck passes
- build passes
- relevant tests pass
- the feature is complete, not a skeleton

## Decision rules

When a decision is ambiguous:

- choose the simpler implementation
- choose the more reusable path only if reuse is immediate and real
- choose the option that creates less future cleanup
- do not add speculative abstractions

## Planning rule

Plan by feature boundary, not by quality tier or time phase.

- "Auth system" is one deliverable. Build it complete: UI, API, validation, error states, all of it.
- "Dashboard" is one deliverable. Build it complete: layout, data display, loading states, responsive, all of it.
- Never plan like "Phase 1: basic layout, Phase 2: add interactivity, Phase 3: polish". That is wasted overhead.
- If a feature is genuinely too large for one session, split into independent sub-features that each ship complete.

## Delivery principles (project-wide, non-negotiable)

- **No minimal-viable hand-off. Always deliver completely.** Do not stop a
  task half-done. If something blocks you mid-task, resolve the blocker
  first; finish the full chain before reporting back.
- Do not present "A or B" menus to the user unless the choice is genuinely
  user-only (preference, irreversible action, account binding, money). For
  everything else, pick the most defensible path and execute.
- When you hit an obstacle (missing dep, broken config, dead external
  service), try to auto-fix first. Only escalate after attempting a fix, and
  bring a single recommended path with the report — never bring an
  unfiltered list of options.
- Run validation (lint, typecheck, browser sanity check) before claiming
  done. A task is not complete until evidence shows it works.

## Rule-file edit rule

- Do not edit `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, or any file under
  `/spec` unless explicitly asked. Those are the source of truth and
  off-limits to ambient cleanup.
