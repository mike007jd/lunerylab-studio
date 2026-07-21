# Settings Surface Contract

Settings owns runtime, provider, language, and local model configuration.

## Ownership

- Owner: `my-app/components/settings`
- Route: `/settings`
- Role: local runtime, provider, and model management surface

## Role

Settings is where capability is installed, connected, tested, and repaired.
It should not compete with Studio as the main creative workspace.

## Required Structure

- Runtime health.
- Local models.
- Provider connections.
- Cost/local-first mode.
- Language and product preferences.

## Required States

- Empty capability.
- Local runtime ready.
- Runtime unreachable.
- Download pending.
- Download resumable.
- Secret saved.
- Connection test failed.
- Connection test passed.

## Framework Rules

- Keep technical detail scannable and grouped.
- Prefer status rows and compact cards over large marketing blocks.
- Any provider secret interaction must preserve the desktop keychain boundary.

