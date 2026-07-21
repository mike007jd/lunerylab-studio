# Canvas Surface Contract

Canvas is the visual context and artifact editing surface.

## Ownership

- Owner: `my-app/components/canvas`
- Route: `/canvas/[sessionId]`
- Role: artifact editing and visual context surface

## Role

Canvas helps users inspect, mask, arrange, and refine generated assets. It is not
the primary entry point for model management or generic chat.

## Required Structure

- Asset stage.
- Selection and layer context.
- Focused edit actions.
- Assistant handoff only when it advances the edit workflow.

## Required States

- Empty session.
- Asset selected.
- Mask/edit pending.
- Capability missing.
- Export or result ready.
- Recoverable canvas error.

## Framework Rules

- Use stable dimensions for toolbars, badges, and side panels.
- Keep canvas-specific non-CSS drawing values isolated and justified.
- Keep Konva implementation details inside the focused canvas surface.
