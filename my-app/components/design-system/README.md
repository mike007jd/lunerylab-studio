# Design System

This folder is the framework boundary for Lunery Lab UI work.

- `primitives`: local primitive exports only.
- `grammar`: named UI language, tokens, density, motion, and interaction rules.
- `shell`: reusable surface shells and layout rhythm.
- `assistant`: assistant-ui presentation/runtime boundary.
- `surfaces`: surface ownership registry.

Feature code should reuse this folder before creating new local styling grammar.

