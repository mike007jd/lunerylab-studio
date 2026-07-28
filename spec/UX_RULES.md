# UX Rules

The interface should feel fast, calm, and predictable. Every surface presents
one obvious next step.

## Desktop Viewport

Studio is a desktop product, not a mobile or browser surface.

- Baseline window: `1440 × 980`.
- Minimum supported window: `1180 × 760`.
- Prevent overflow and broken wrapping at the minimum size.
- Larger windows may add breathing room, never extra product complexity.
- Narrow layouts may remain resilient, but mobile/tablet breakpoints are not
  release acceptance targets.

## State Contract

- Render states in this order: loading, blocking error with retry, empty, data.
- A first-load error is not an empty state. Refresh errors may coexist with
  retained data.
- Loading preserves control and surface geometry.
- Media failure ends loading and shows a visible unavailable state.
- Persisted-content actions resolve against current state and provide recovery
  when the target no longer exists.
- Distinct states look distinct; do not collapse checking, ready, unreachable,
  pending, and missing into a single neutral badge.

## Interaction

- One accent primary action per view. Secondary actions use lower emphasis.
- Every interactive element has visible focus, disabled, loading, and error
  treatment where applicable.
- Forms keep visible labels, preserve input after validation errors, and explain
  the corrective action.
- Use skeletons for content regions, inline status for small actions, and toasts
  only as secondary confirmation.
- Selection, loading, and user-generated labels must not move surrounding
  geometry.

## Progressive Disclosure

- Show only controls required for the creative task.
- Put hardware, imports, runtime probes, and parameter detail in the shared,
  default-collapsed `AdvancedDisclosure`.
- Demote progress, error reasons, and health diagnostics; never delete them.
- Assistant behavior supports direct creation and editing. It does not replace
  the Studio with a generic chat surface.

## Accessibility

- Use semantic HTML and keyboard-complete interactions.
- Keep focus visible and contrast sufficient.
- Respect reduced motion.
- Keep targets usable at the minimum desktop window size.

## Motion

Motion may clarify state, responsiveness, or spatial continuity. Use the named
presets in `components/design-system/grammar/motion.ts`; do not copy durations
or easing values into components or docs. Exit never outlasts entry. CSS
animation is limited to controlled loading or navigation feedback.

## Verification

`pnpm ui:check` detects static framework drift. `pnpm test:unit` verifies shared
primitive and state behavior. Validate rendered UI in the current Tauri build at
the minimum and baseline window sizes.
