# Lunery Lab human-maintainability plan

This package deliberately avoids a broad rewrite. The stable storage, idempotency, provider, and native-engine boundaries are worth preserving. The first goal is to stop Studio lifecycle complexity from accumulating in a single page.

## What the deeper source pass confirmed

The backend has several good seams:

- `lib/server/idempotency.ts` owns same-key replay and insert races.
- `lib/server/generation-job.ts` owns terminal job transitions.
- the image route keeps asset creation and job completion in one transaction.
- `lib/client/sd-progress.ts` keeps native progress advisory and abortable.
- `use-video-generation.ts` owns one video job and guards overlapping polls.
- Rust residency uses leases, generation identities, and fail-closed estimates.

The main front-end seam is missing. `components/studio/studio-page.tsx` owns:

- image and video modes;
- model/preset/project/reference state;
- upload and request construction;
- progress polling and cancellation;
- history and retries;
- send-to-canvas;
- notices, dialogs, hydration, and the full render tree.

## Confirmed lifecycle defect

Image retries use a keyed single-flight guard, so two different history entries may retry concurrently. They nevertheless share a single page-level `isGenerating` boolean.

A possible sequence:

1. Retry entry A.
2. Retry entry B before A finishes.
3. A finishes and sets `isGenerating = false`.
4. B is still running, but the results grid receives `busy = false`.

The state model is wrong even if this is rare. Activity must be keyed or counted, not represented by one boolean.

## Refactor sequence

### PR 1 — keyed generation activity

Introduce a keyed registry whose source of truth is a map from entry ID to run identity:

```ts
interface ActiveGeneration {
  entryId: string;
  runId: string;
  mode: 'image' | 'video';
  requestController?: AbortController;
  pollController?: AbortController;
  cancelRequested: boolean;
}
```

Derive:

```ts
const anyGenerationActive = activeGenerations.size > 0;
const entryBusy = activeGenerations.has(entryId);
```

Do not maintain a second global boolean.

### PR 2 — image generation controller

Move these responsibilities out of `StudioPage`:

- build `FormData`;
- capability filtering;
- create/cancel progress poll;
- request abort;
- history terminal update;
- retry from a history snapshot.

Target API:

```ts
const imageGeneration = useImageGenerationController({
  imageModels,
  history,
  translate: t,
});
```

The page should call `submit`, `retry`, and `cancel`; it should not own controllers or run IDs.

### PR 3 — video controller integration

`use-video-generation.ts` is already a useful boundary, but the page mirrors its result into history using `activeVideoEntryId`.

Replace that bridge with an entry-aware controller:

```ts
submit({ entryId, ...request })
```

The controller should update the matching history entry directly and expose per-entry state.

### PR 4 — presentation split

After lifecycle extraction, split:

- `StudioComposer`
- `StudioGenerationSurface`
- `GenerationEntryCard`
- `AssetCompareDialog`
- `GenerationFailureCard`

Keep history entries as the presentation source of truth.

### PR 5 — shared persisted schemas

Replace the hand-written localStorage DTO validator with Zod schemas shared by:

- API response parsing;
- history persistence;
- tests.

Do not maintain a second handwritten copy of `AssetDTO`.

### PR 6 — native engine lifecycle

Extract the common Tauri process lifecycle shared by llama and MLX:

- epoch/generation ownership;
- child slot;
- start serialization;
- readiness;
- PID lock;
- monitor and rollback;
- residency registration.

Each engine should supply command construction, identity, memory estimate, and readiness strategy.

## Testing policy

Prefer:

- reducer/controller tests for run identity and concurrency;
- API contract tests;
- transaction and cleanup tests;
- rendered accessibility tests;
- native lifecycle tests.

Reduce:

- exact source snippets;
- exact helper names;
- implementation ordering assertions in `check-ui-framework.mjs`.

## What the ratchet does

`pnpm check:maintainability`:

- prevents `studio-page.tsx`, `generation-results-grid.tsx`, and the custom UI scanner from growing;
- allows every reduction without baseline edits;
- rejects a newly introduced oversized module unless it receives an explicit reviewed temporary ceiling;
- rejects growth in an existing oversized legacy module while allowing it to stay flat or shrink;
- compares against `HEAD^`, while named hotspots also have fixed reviewed ceilings;
- prints the next intended ownership boundary in CI.

## Completion criteria

Remove the current ratchet entries when:

- `studio-page.tsx` is below 450 lines and owns no request controllers;
- `generation-results-grid.tsx` is below 400 lines;
- `check-ui-framework.mjs` is below 250 lines, with JSX behavior moved to standard tooling;
- generation busy state is per entry or derived from a keyed activity registry.
