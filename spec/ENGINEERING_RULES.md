# Engineering Rules

## Stack defaults for new projects

Use these defaults for new greenfield builds unless the repo already chose otherwise:

- Next.js with App Router
- TypeScript
- Tailwind CSS
- shadcn/ui
- Lucide icons
- Framer Motion
- React hooks and local state by default
- Prefer pnpm unless the repo already uses npm, yarn, or bun

## Version policy

Do not hardcode dependency versions in this spec.

Instead:

- before installing or upgrading a dependency, verify the latest stable version
  from official docs or the package registry
- for new projects, prefer the current stable version
- for existing projects, stay compatible with the repo's current major versions
  unless an upgrade is explicitly requested
- do not introduce canary or beta releases by default

## Bootstrapping rule

For new Next.js apps:

- prefer the official project bootstrap flow
- default to TypeScript, Tailwind, and App Router
- keep the setup close to framework defaults unless there is a strong reason not to

## Next.js architecture rules

- Default to Server Components.
- Add `use client` only when interactivity, browser APIs, or client-only hooks are required.
- Keep data fetching close to the route or server component that owns it.
- Use URL params or search params for shareable view state when appropriate.
- Avoid pushing everything into client state by default.

## Folder structure

Use this baseline structure unless the repo already has a clear alternative:

- `app/` - routes, layouts, route-level UI
- `components/ui/` - shadcn-based primitives and wrappers
- `components/shared/` - reusable presentational components
- `components/features/` - product-specific feature components
- `hooks/` - reusable hooks
- `lib/` - utilities, helpers, data clients, config helpers
- `types/` - shared TypeScript types

## Component rules

- Reuse existing components before creating new ones.
- Base primitives should come from shadcn/ui whenever possible.
- Prefer composition over inheritance and deep abstraction.
- Keep components focused and predictable.
- Avoid giant components that mix layout, state orchestration, and rendering.
- Promote a component to shared only when reuse is real, not hypothetical.

## Styling rules

- Tailwind is the default styling system.
- Use semantic tokens and utility classes.
- Use `cn()` for conditional class composition.
- Avoid CSS Modules by default.
- Avoid inline styles except for truly dynamic values that cannot be expressed cleanly.
- `globals.css` should be limited to Tailwind layers, CSS variables, resets, and framework-level styling.

## Design system implementation rules

- Do not hardcode ad hoc colors in components.
- Do not add random spacing values to "make it look right".
- Do not create duplicate button, input, modal, or card primitives.

## Animation rules

- Use Framer Motion when motion is needed.
- Do not invent a second animation system.
- Do not add decorative motion without UX value.

## State management rules

Default order of preference:

1. local component state
2. lifted state within a feature
3. URL state when the state should be shareable or navigable
4. server state patterns close to the route boundary

Do not introduce a global state library unless the problem clearly requires it.

## Storybook policy

Do not add Storybook by default.

Add Storybook only when one of these is true:

- the project is becoming a reusable component library
- multiple contributors need a dedicated component development surface
- Storybook is explicitly requested

## Dependency policy

- Avoid adding new libraries when the current stack already solves the problem.
- Ask whether a dependency is truly needed before installing it.
- Prefer smaller, well-maintained libraries over broad toolkits.

## Validation rules

Before declaring a task complete, run the relevant verification commands.

Minimum expected checks for frontend work:

- lint
- typecheck
- build

Also run tests when logic, data transformation, or reusable behavior changed.

If validation fails:
- fix the failure before continuing or closing the task
