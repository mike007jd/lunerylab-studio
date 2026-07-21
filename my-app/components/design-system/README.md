# Design System

This folder is the framework boundary for Lunery Lab UI work.

- `grammar`: named UI language, tokens, density, motion, and interaction rules.
- `shell`: console content-frame classes and layout rhythm helpers.

Feature code imports these modules by deep path
(`@/components/design-system/grammar/*`, `@/components/design-system/shell`)
and uses shadcn primitives directly from `@/components/ui/*`.

Surface ownership lives in `docs/design/surfaces/*`. Assistant presentation
lives in `components/studio/agent-chat/*`.
