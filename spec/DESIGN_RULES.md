# Design Rules

## Product DNA

Luna Studio is a focused creative workspace: matte dark surfaces, moon-white
text, silver primary actions, restrained gold for high-signal status, crisp
borders, compact controls, and artwork-first hierarchy.

It must not look like a SaaS dashboard, generic chat app, model manager,
marketing page, or decorative glassmorphism showcase.

## Authoritative Paths

| Concern | Source |
| --- | --- |
| CSS tokens and bridges | `my-app/app/globals.css` |
| Typed token names | `my-app/components/design-system/grammar/tokens.ts` |
| JavaScript motion | `my-app/components/design-system/grammar/motion.ts` |
| Shared primitives | `my-app/components/ui` |
| Shell rhythm | `my-app/components/design-system/shell` |
| Surface contracts | `docs/design/surfaces` |

Do not copy token values into documentation. Components consume semantic token
classes; raw colors, shadows, radii, easing, and ad hoc text sizes are forbidden
unless the implementation boundary requires and documents them.

## Visual Invariants

- Generated work is visually dominant; runtime and provider status is
  subordinate.
- Use local shadcn primitives, the repo icon wrappers, and existing shell
  helpers.
- One role has one visual treatment. Do not create duplicate button, field,
  card, badge, or modal grammars.
- Keep borders, focus treatment, radius, density, type hierarchy, and icon
  alignment consistent across equivalent controls.
- Use elevation only to express hierarchy. Avoid decorative gradients, ambient
  animation, and heavy blur in utility surfaces.
- A card or row shows at most three metadata items by default. Reveal the rest
  progressively.
- Collapse adjacent status badges into one short, meaningful signal.

## Copy

The audience is artists and everyday non-technical users.

- Use product terms such as Local AI, API Key, Cloud, Reference, Size, Count,
  and Style. Avoid backend, provider, BYOK, endpoint, runtime, bridge,
  inference, keychain, quantization, and file-format jargon in visible copy.
- Keep titles near six words, helper text to one short line, and empty states to
  one sentence plus one action.
- Explain what to do, not internal architecture.
- Keep `en`, `zh-CN`, and `zh-TW` aligned. Documentation remains English even
  when the product UI is localized.
- Do not use billing, credits, team, Pro, enterprise, account, or narrow
  e-commerce language.

## Gate

`pnpm ui:check` enforces static framework drift. `pnpm test:unit` owns shared
primitive behavior. Run both through `pnpm verify`.
