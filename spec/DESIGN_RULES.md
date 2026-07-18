# Design Rules

## Design philosophy

The UI should feel intentional, clean, and consistent.

The goal is not maximal visual novelty.
The goal is a polished product surface with a controlled visual language.

## Token-first rule

Visual decisions should come from tokens, not ad hoc local tweaks.

Use semantic tokens for:

- color
- spacing
- radius
- shadow
- typography
- motion

Avoid one-off values unless there is a documented exception.

## Color system

Use semantic color roles instead of hardcoded meaning per component.

Core roles:

- primary
- secondary
- background
- surface
- border
- muted
- accent
- success
- warning
- destructive

Rules:

- do not hardcode hex colors inside feature components
- keep tokens centralized
- component styling should consume tokens, not invent new palette logic

## Typography scale

Use a small, stable typography system.

Recommended scale:

- `h1`
- `h2`
- `h3`
- `h4`
- `body`
- `body-sm`
- `caption`

Rules:

- headings should express hierarchy clearly
- body text should optimize readability first
- avoid random font-size jumps between nearby UI elements
- avoid using font weight as the only hierarchy signal

## Spacing scale

Use a consistent spacing scale.

Recommended scale:

- 4
- 8
- 12
- 16
- 20
- 24
- 32
- 40
- 48
- 64
- 80

Rules:

- use scale values instead of arbitrary pixel tweaks
- similar component types should use similar internal spacing
- page rhythm matters more than local perfectionism

## Radius scale

Use a small radius system.

Recommended tokens:

- `sm`
- `md`
- `lg`
- `xl`

Rules:

- cards, inputs, modals, and buttons should feel related
- do not mix sharp and very rounded styles without a product reason

## Shadow system

Use semantic elevation instead of arbitrary shadow strings.

Recommended tokens:

- `card`
- `dropdown`
- `modal`

Rules:

- increase shadow only when elevation meaning increases
- avoid noisy shadows on already busy surfaces

## Icon rules

Use Lucide by default.

Recommended sizes:

- 16
- 18
- 20
- 24

Rules:

- keep icon sizing consistent inside similar controls
- do not mix multiple icon families unless explicitly required

## Component visual consistency

Across shared UI components, keep the following stable:

- border treatment
- focus treatment
- corner radius
- spacing density
- typography hierarchy
- icon alignment

## Do not do these by default

- random per-page palettes
- arbitrary glassmorphism or blur effects everywhere
- heavy gradients on utility UI
- one-off custom utility classes for every component
- visually different buttons that mean the same thing

## Simplicity for non-expert users

Primary audience: artists and everyday non-technical users with average
computer skills. Optimize the UI for them, not for power users.

Visual density:

- a card or row shows at most 3 meta items by default; demote the rest
  (format, RAM, source/verification, layer counts, success ratios) to muted
  small text, tooltip, or hover/expand reveal
- express readiness / connection / run status as an icon + short label
  (+ optional tooltip), never a full sentence
- do not place 3 or more status badges side by side; collapse to one signal

Plain language (no jargon):

- UI copy must avoid engineering terms: model, backend, provider, BYOK,
  endpoint, runtime, bridge, inference, reachability, keychain, `.cpp`, SHA,
  GGUF, quantization
- use the shared product vocabulary instead (Local AI / API Key / Cloud;
  Reference; Size; Count; Style) — see the `modelSource` i18n namespace
- internal identifiers and variable names are unaffected; this is about
  visible copy only

Copy limits:

- title around 6 words or fewer; one helper line around 12 words or fewer;
  empty state is one sentence plus one action
- cut "why you need X" explanations; keep "what to do"
- keep all three locales (en / zh-CN / zh-TW) in sync; prefer short phrasing,
  especially in Chinese
