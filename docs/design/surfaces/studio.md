# Studio Surface Contract

Studio is the primary production surface.

## Ownership

- Owner: `my-app/components/studio`
- Route: `/studio`
- Role: primary creative production surface

## Role

The user should be able to create, inspect, iterate, and hand off assets without
thinking about providers first.

## Required Structure

- Composer as the primary action region.
- Recent/generated results visible without a navigation detour.
- Capability/runtime status present but subordinate.
- Assistant thread available as a helper, not as the whole product.

## Required States

- No configured capability.
- Local runtime available.
- BYOK runtime available.
- Generation pending.
- Generation failed with recovery action.
- Generated asset preview.
- Multi-result selection.

## Framework Rules

- Use `components/design-system` before adding new layout grammar.
- Do not add raw visual values.
- Do not introduce provider/model management inside the primary composer.
- Keep video secondary and lower density than image generation.

