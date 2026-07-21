# Feature Reference

Checked on 2026-06-19 against current routes, components, server modules, and
Prisma schema.

This is the feature map for launch and maintenance. It describes what exists,
where it lives, and which backend contracts support it.

Paths in feature tables are relative to `my-app/` unless they start with
another repository-root directory.

## Desktop Shell

| Feature | User value | Main files |
| --- | --- | --- |
| Tauri shell | Runs Studio as a desktop app with a private local server. | `src-tauri/*`, `tauri.conf.json` |
| Runtime bridge | Lets Next API routes control local engines and secret storage. | `lib/server/desktop-bridge.ts`, `app/api/desktop-runtime/*` |
| Desktop route gate | Redirects browser users to the standalone website. | `proxy.ts`, `lib/desktop-runtime.ts`, `lib/public-site.ts` |
| Build resources | Embeds standalone Next app and engine sidecars. | `scripts/desktop-clean.mjs`, `scripts/desktop-bundle-assets.mjs`, `scripts/fetch-*.mjs` |

## Studio

| Feature | User value | Main files |
| --- | --- | --- |
| Prompt composer | Primary image/video generation surface. | `app/(console)/studio/page.tsx`, `components/studio/studio-page.tsx` |
| Presets and modes | Reusable creative prompt modules and style presets. | `lib/prompts/creative-workflows.ts`, `lib/presets/style-presets.ts` |
| Reference upload | Adds uploaded images as generation context. | `components/studio/hooks/use-studio-reference-files.ts`, `app/api/assets/upload/route.ts` |
| Prompt optimization | Improves prompts through configured local/BYOK text runtime. | `app/api/prompts/optimize/route.ts`, `lib/server/prompt-optimizer.ts` |
| Generation history | Shows generated assets and job state. | `components/studio/use-studio-generation-history.ts`, `components/studio/generation-results-grid.tsx` |
| Video controls | Submits and polls video generation jobs. | `components/studio/video-controls.tsx`, `components/studio/hooks/use-video-generation.ts` |

Studio should remain the main creative workspace, not a generic chat shell or
model manager.

## Generation Runtime

| Feature | User value | Main files |
| --- | --- | --- |
| Runtime supply | Chooses available local or BYOK backend per capability. | `lib/server/runtime-supply.ts` |
| Image generation | Produces and stores generated images. | `app/api/generate/images/route.ts`, `lib/server/image-generate.ts` |
| Local image engines | Uses sd-cpp or ComfyUI-style endpoints when ready. | `lib/server/local-sd.ts`, `lib/server/local-image.ts` |
| BYOK image providers | Uses OpenAI, OpenAI-compatible, Fal, Replicate, and related providers. | `lib/server/byok-image.ts`, `lib/server/byok-image-adapters.ts`, `lib/server/byok-image-catalog.ts` |
| BYOK text providers | Uses AI SDK models for text and structured prompt work. | `lib/server/byok-llm.ts`, `lib/server/byok-provider-config.ts` |
| Video generation | Submits and polls provider video jobs. | `app/api/generate/video/route.ts`, `app/api/generate/video/[jobId]/status/route.ts`, `lib/server/byok-video.ts` |
| 3D generation | Agent-accessible BYOK 3D generation. | `lib/server/byok-3d.ts`, `lib/server/agent/runtime/tools/generate-3d.ts` |

No generation path may silently choose a hardcoded model when the user has not
selected or configured one.

## Agent And Canvas

| Feature | User value | Main files |
| --- | --- | --- |
| Agent chat | Natural-language helper for canvas operations. | `app/api/chat/route.ts`, `components/studio/agent-chat/*` |
| Agent executor | Runs AI SDK tool loops with deterministic action support. | `lib/server/agent/runtime/executor.ts`, `lib/server/agent/runtime/run.ts` |
| Agent tools | Observe, generate, edit, inpaint, remove background, move layers, export. | `lib/server/agent/runtime/tools/*` |
| Canvas editor | Focused Konva asset editor with persisted layers, transforms, pan/zoom, and masks. | `app/canvas/[sessionId]/page.tsx`, `components/canvas/*` |
| Canvas snapshots | Saves rollback points after agent and user changes. | `lib/server/canvas-snapshot.ts`, `app/api/canvas/sessions/[id]/snapshots/*` |
| Layer APIs | Persist layer geometry, ordering, visibility, and deletion. | `app/api/canvas/sessions/[id]/layers/*`, `lib/server/canvas-layer-order.ts` |

Agent UI should use assistant-ui as the presentation/runtime layer while keeping
the backend agent contract in `lib/server/agent/runtime`.

## Library And Projects

| Feature | User value | Main files |
| --- | --- | --- |
| Library | Browse projects, assets, jobs, and generated media. | `app/(console)/library/page.tsx`, `components/library/*` |
| Projects | Group Studio work without deleting existing assets when removed. | `app/api/projects/*`, `lib/server/project-ownership.ts` |
| Assets | Serve, update metadata, favorite, tag, and note assets. | `app/api/assets/*`, `lib/server/storage.ts` |
| Jobs | Track generation status and failures. | `app/api/jobs/*`, `lib/server/generation-job.ts`, `lib/server/video-job.ts` |
| Reference sets | Save project-scoped bundles of reusable creative references. | `app/api/projects/[id]/reference-sets/*`, `lib/server/reference-set.ts` |
| Sample projects | Seed first-run content for the local workspace owner. | `lib/server/sample-projects.ts`, `lib/sample-data.ts` |

Project deletion detaches associated records instead of deleting the underlying
media history.

## Settings

| Feature | User value | Main files |
| --- | --- | --- |
| Desktop runtime overview | Shows bridge availability, local engines, and health. | `components/settings/desktop-runtime-card.tsx`, `components/settings/runtime-health-panel.tsx` |
| Provider connections | Stores BYOK endpoints, model ids, and connection metadata. | `components/settings/desktop-runtime/provider-connections-panel.tsx`, `app/api/desktop-runtime/provider-connections/route.ts` |
| Provider secrets | Saves and deletes provider keys through the desktop bridge. | `app/api/desktop-runtime/provider-secret/route.ts`, `src-tauri/src/secrets.rs` |
| Local model catalog | Shows install/import/run state for local models. | `components/settings/local-models-panel.tsx`, `lib/hf-model-catalog.ts` |
| HF download/import | Downloads model artifacts and imports local files. | `app/api/desktop-runtime/hf-download/*`, `app/api/desktop-runtime/models/import/route.ts` |
| Language/default settings | Persists locale and selected default model. | `components/settings/settings-language-card.tsx`, `components/settings/settings-default-model-card.tsx` |

Settings owns model/runtime setup. Studio should consume readiness, not become a
model-management screen.

## Platform Services

| Feature | User value | Main files |
| --- | --- | --- |
| Bootstrap snapshot | Hydrates initial settings/runtime/catalog state. | `app/api/bootstrap/route.ts`, `lib/client/use-bootstrap-snapshot.ts` |
| Models API | Returns model catalog to clients. | `app/api/models/route.ts`, `lib/server/model-catalog.ts` |
| Storage service | Stores uploaded/generated files on the local filesystem under the Lunery media profile. | `lib/server/storage.ts` |
| i18n | Provides English, Simplified Chinese, and Traditional Chinese UI copy. | `lib/i18n/*` |
| UI framework gate | Keeps surface code aligned with the Luna design system. | `scripts/check-ui-framework.mjs`, `ui-framework.config.json` |
| AI freshness gate | Verifies current model/provider ids and source URLs. | `scripts/audit-ai-freshness.mjs` |

## Launch-Critical Invariants

- Desktop Studio is the real product; distribution and marketing are maintained separately.
- No hardcoded generation fallback model.
- No provider key should be exposed to client UI.
- Runtime media in `data/` is generated user content, not source.
- Tauri and local engine artifacts are regenerated by scripts, not hand-edited.
- Source docs are `/spec`; execution docs live under `/docs`.
