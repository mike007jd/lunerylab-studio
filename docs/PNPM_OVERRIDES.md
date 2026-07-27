# pnpm overrides — context

`my-app/pnpm-workspace.yaml` declares transitive overrides. Each one exists to work
around a real, observable issue, not as a precaution. Drop an override only
after confirming the upstream issue is fixed in every consumer.

Last checked: 2026-07-27 against `my-app/pnpm-workspace.yaml`, the npm registry,
and `pnpm audit`.

## `defu` → `^6.1.5`

Some assistant-ui / radix transitive dependencies still resolve to defu
< 6.1.5, which carries a prototype-pollution bug
(<https://github.com/unjs/defu/security/advisories>). The override forces every
copy in the dependency graph to the patched line. Dropping this re-introduces
the vulnerability on any path that goes through the old transitive.

## `effect` → `^3.20.0`

`shadcn` 3.x emits some scaffolding that pulls `effect` 2.x as a transitive.
The 3.x line is the supported one for the rest of the dep graph (assistant-ui
uses 3.x APIs internally). Without this override pnpm resolves a mix of 2.x
and 3.x and the smaller copies miss runtime types that newer consumers expect.

## `postcss` → `8.5.23`

The prior `^8.5.10` range still resolved 8.5.15 and failed the required
dependency audit for GHSA-r28c-9q8g-f849, which is patched in 8.5.18. The npm
registry's current release on 2026-07-27 is 8.5.23, so the override is exact:
audits remain deterministic and cannot drift back below the patched floor.

## Dev/tooling audit overrides

These overrides keep the full dependency audit clean for launch while avoiding
unrelated framework or product-library upgrades:

- `flatted` -> `3.4.2`
- `@hono/node-server` -> `1.19.14`
- `fast-uri` -> `3.1.2`
- `hono` -> `4.12.26`
- `ip-address` -> `10.2.0`
- `js-yaml` -> `4.3.0`
- `qs` -> `6.15.2`
- `path-to-regexp@>=8.0.0 <8.4.2` -> `8.4.2`
- `picomatch@^2.0.0` -> `2.3.2`
- `picomatch@^4.0.0` -> `4.0.4`
- `brace-expansion@^1.0.0` -> `1.1.16`
- `brace-expansion@^5.0.0` -> `5.0.8`

GHSA-mh99-v99m-4gvg is fixed in 5.0.8. The legacy 1.x line has no patched
release as of 2026-07-27 and is still required by minimatch 3 in ESLint tooling.
A cross-major override is not compatible (`minimatch` expects the 1.x
CommonJS function, while 5.x exposes named exports) and makes `pnpm lint`
crash. Keep the audit red and visible until the upstream toolchain removes that
dependency; do not suppress the advisory or substitute the incompatible major.
- `undici` -> `6.27.0`

The vulnerable paths observed on 2026-06-08 were in development tooling:
`eslint`, `eslint-config-next`, `shadcn`, and their MCP / Express / globbing
transitives. Production audit was already clean, but launch CI treats the full
audit as a required gate.

## When to remove

Each override stops being necessary once **every** transitive consumer in the
lockfile resolves to a version at or above the override floor on its own. Use
`pnpm why <pkg>` to verify before deleting an entry; if the override is
removed prematurely, the issue reappears silently.
