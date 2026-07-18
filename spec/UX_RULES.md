# UX Rules

## UX philosophy

The interface should feel fast, calm, and predictable.

Motion and styling should support clarity, not compete for attention.

## Layout rhythm

Use a stable page rhythm.

Recommended page padding:

- mobile: 16
- tablet: 24
- desktop: 32

Recommended content width:

- standard content max width: 1200 to 1280
- narrow reading width for text-heavy surfaces: around 720 to 800

Recommended section spacing:

- major section gap: 48 to 64
- card grid gap: 16 to 24
- compact control gap: 8 to 12

Rules:

- use mobile-first layout decisions
- avoid cramped sections
- avoid giant empty gaps with no hierarchy purpose

## Responsive behavior

Every important surface should work at three widths by default:

- mobile around 390
- tablet around 768
- desktop around 1280

Rules:

- do not design only for desktop
- avoid hidden critical actions on mobile
- avoid overflow and broken wrapping in cards, tables, and nav

## Interaction states

Interactive elements should have clear states.

At minimum, design for:

- default
- hover
- active / pressed
- focus-visible
- disabled
- loading
- error
- success when applicable

Rules:

- focus state must be visible
- disabled state must still be understandable
- loading state must preserve layout stability

## Motion rules

Use Framer Motion only when motion improves comprehension.

Recommended durations:

- micro interaction: 120ms
- hover / tap feedback: 150ms to 180ms
- popover / dropdown: 180ms to 220ms
- modal: 220ms to 280ms
- page or large section transition: 250ms to 320ms

Recommended easing:

- ease-out
- ease-in-out

Rules:

- avoid long or floaty transitions
- avoid multiple simultaneous decorative animations
- respect reduced motion preferences
- prefer subtle opacity, transform, and elevation changes

## Button rules

Use a small stable button system.

Expected variants:

- primary
- secondary
- ghost
- destructive
- link when appropriate

Rules:

- each view should usually have one dominant primary action
- secondary actions should not visually compete with the primary CTA
- destructive actions must look meaningfully different

## Form UX rules

Forms should optimize clarity and recovery.

Rules:

- every field should have a visible label
- helper text should be concise and useful
- error text should explain what to fix
- submit buttons should show pending state
- preserve user input on validation errors where possible

## Feedback rules

Design for all major non-happy paths.

Important states:

- loading
- empty
- error
- success / confirmation
- partial data when relevant

Rules:

- do not ship blank white states for loading or empty content
- prefer skeletons for content regions and inline status for small actions
- use toasts sparingly for secondary confirmation, not as the only feedback channel

## Accessibility rules

Minimum expectations:

- keyboard navigable interactions
- visible focus states
- sufficient contrast
- semantic HTML where possible
- reduced motion respect
- clickable targets that are not too small on mobile

## Motion and delight guardrail

Do not use custom animation for its own sake.

If a motion choice does not improve:
- state clarity
- perceived responsiveness
- spatial continuity

then do not add it.

## Simplicity and progressive disclosure

Audience: non-technical artists and everyday users. Every surface must read as
"one obvious next step".

One primary action per screen:

- exactly one accent primary CTA per view
- secondary actions are ghost, icon-only, or inside a menu, and must not
  compete with the primary CTA

Progressive disclosure:

- by default show only what is required to complete the creative task
- collapse advanced and diagnostic controls (hardware, search, import,
  runtime probing, parameter detail) into a default-collapsed "Advanced"
  section — use the shared `AdvancedDisclosure` primitive

Necessary information is demoted, never deleted:

- progress, error reasons, and connection / health status must remain
  available — shorten the wording and move it to a secondary position, but
  never remove it entirely
- this is a local-first + BYOK product; users still need this to self-diagnose
