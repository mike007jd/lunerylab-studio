# Lunery Lab UI Framework Stack

This is the production UI/UX framework contract for Lunery Lab.

It governs implementation under `my-app/`. Product specs and feature plans can
add requirements, but they should not bypass this stack.

## Ownership

- UI ownership stays inside `my-app`.
- Shared visual primitives live in `my-app/components/ui`.
- Framework grammar and shell helpers live in `my-app/components/design-system`.
- Feature surfaces live in their existing route/component folders until a
  surface is intentionally moved behind a design-system boundary.
- Do not create a shared UI package for this repo.

## Stack

- Next.js App Router + React 19 + TypeScript.
- Tailwind CSS v4 as the token and utility compiler.
- shadcn/ui as local accessible primitives only.
- assistant-ui as assistant thread/composer/runtime primitives only.
- Framer Motion as the only animation syntax.
- Lucide icons through the repo's icon wrappers.
- Sonner for transient feedback.
- Zustand only for real cross-component client state.
- Zod for runtime validation and API boundary parsing.

Do not introduce a second styling system, a second primitive library, or a
parallel assistant runtime.

## Visual Language

The current design language is Luna Studio: moonlight atelier, matte dark
surfaces, silver primary actions, restrained gold accent, dense creator-studio
workflow, and quiet local-first runtime controls.

Hard rules:

- Visual values come from tokens in `my-app/app/globals.css`.
- Components consume semantic token classes such as `bg-(--bg-surface)`,
  `text-(--text-muted)`, `border-(--border-subtle)`, `shadow-(--shadow-sm)`.
- Raw hex, raw rgba, arbitrary radius, arbitrary shadow, and arbitrary text
  sizes are not allowed in new framework code.
- shadcn defaults must be restyled into Luna Studio before use in surfaces.
- Motion should clarify state, hierarchy, or continuity; decorative motion is
  not a framework feature.

## Motion Grammar

`my-app/components/design-system/grammar/motion.ts` is the single runtime source
for Framer Motion foundations, semantic transitions, springs, and variants.
Component files may not write numeric Framer `duration` or easing arrays.

| Tier | Duration | Intent |
| --- | ---: | --- |
| `micro` | 120ms | press, tap, and icon feedback |
| `control` | 160ms | hover, focus, selection, and color state |
| `overlay` | 200ms | popover, menu, tooltip, and tab reveal |
| `modal` | 240ms | dialog, sheet, and comparison surfaces |
| `surface` | 260ms | page and large-region continuity |
| `exit` | 160ms | every dismissal and departure |

The CSS mirror lives in `my-app/app/globals.css` as `--motion-*` and
`--ease-luna-*`; both files must change together. Tailwind consumers use
`duration-(--motion-*)` with `ease-luna-*` and list the exact transitioned
properties instead of `transition-all`. Exit may never be slower than entry.
Springs are reserved for direct manipulation or retargetable spatial feedback.

`pnpm ui:check` blocks four drift classes: numeric Framer durations, inline
Framer easing arrays, `transition-all`, and raw `cubic-bezier(...)` outside the
CSS token bridge. The only allowlisted exception is the motion grammar file
itself.

## Directory Contract

`my-app/components/design-system/primitives`

- Re-export local shadcn primitives and repo primitives.
- No visual ownership beyond composition.
- No raw Tailwind values.

`my-app/components/design-system/grammar`

- Named token, density, motion, and copy-pattern constants.
- Framework language lives here before it is repeated across surfaces.

`my-app/components/design-system/shell`

- App/surface layout wrappers.
- Owns page rhythm, width, section spacing, and high-level responsive behavior.

`my-app/components/design-system/assistant`

- Assistant UI boundary.
- Keeps assistant-ui presentation/runtime primitives separate from the backend
  agent contract.

`my-app/components/design-system/surfaces`

- Surface registry and ownership notes.
- A surface graduates here only when it has a stable shell, states, and
  interaction grammar.

## Assistant Boundary

The backend truth remains the current canvas-agent API and SSE contract.
assistant-ui is the presentation/runtime layer over that contract.

- Existing backend events remain `step`, `final`, and `error`.
- Assistant messages should stay one assistant turn with typed parts, not a
  stream of unrelated visual rows.
- Composer controls belong to the assistant surface; provider/model/runtime
  management belongs to Settings.
- Do not make the main Studio a generic chat app.

## Surface Rules

Studio is the primary product surface. Canvas, Settings, Library, and Showcase
support the Studio flow.

Every production surface needs:

- loading, empty, error, success, disabled, and pending states where applicable;
- keyboard and focus-visible support;
- mobile, tablet, and desktop layout sanity;
- token-only visual implementation;
- direct action first, assistant as helper where it improves the workflow.

## Hygiene Gates

Run these before declaring UI framework work complete:

```bash
cd my-app
pnpm ui:check
pnpm typecheck
pnpm lint
pnpm build
```

`pnpm ui:check` enforces:

- no second styling system;
- no non-semantic palette utilities;
- no raw visual values inside `components/design-system`;
- no increase over the current raw-value baseline in existing app/components;
- the design invariants below (ledger: `.ai/loops/design-invariants.md`).

## Design Invariants

These are the converged rules the gate now enforces. They exist because each one
was drifted into more than once; a violation fails `pnpm ui:check`.

State contracts

- A routed surface never hides itself while it hydrates. Show a visible,
  `aria-busy` loading shell that holds the same footprint — never an invisible
  surface root.
- State order is loading → blocking error (with a retry action) → empty → data.
  A first-load failure is not an empty state and may not render alongside one.
  Only refresh / load-more errors may coexist with retained data.
- A media failure always ends loading and renders a visible unavailable state.
  `AssetImage` owns that default; a caller `fallback` may replace it but nothing
  can opt out of failure handling.
- An action on persisted content must resolve against current state. A chat
  asset whose Canvas layer is gone shows an unavailable marker and gives the
  user a recovery path — it never renders as a clickable control that does
  nothing.

Stable geometry

- Loading never changes a control's border-box. `Button` overlays its spinner
  and preserves the children's footprint; features must use the `loading` prop
  instead of hand-rolling a spinner or swapping children (including the label)
  on their own loading flag. A size's icon padding must key on the caller's own
  icon (`has-[>svg]` for the asChild path, `has-[[data-slot=button-content]_svg]`
  otherwise) — never on any descendant svg, or the overlay spinner itself
  re-triggers it and shrinks a text-only button while it loads.
- Selection never changes toolbar geometry. Triggers whose label is user data
  are width-bounded and truncate.
- Chrome sharing a screen edge shares one layout lane. No component computes a
  state-driven offset (`bottom-44` / `bottom-20`) to dodge a sibling's height.

Shared grammar

- Same-role form fields share one radius at the primitive boundary: `Input`,
  `Textarea`, and `SelectTrigger` are `rounded-xl`, and consumers may not
  override the radius.
- One semantic row, one implementation. Runtime health rows render through
  `RuntimeHealthRow` with typed view data; behaviour differences are optional
  actions, not a second copy of the chrome.
- States that mean different things must look different. Runtime status is a
  typed `checking | ready | unreachable | missing` union with an exhaustive
  visual map — never a boolean that collapses three states into one muted badge.
