# SDK Integration Governance

Checked on 2026-06-18.

## Source Hierarchy

Use this order when changing AI or SDK integrations:

1. Current vendor documentation and installed package types.
2. `/spec/AI_RUNTIME.md` and `/spec/ENGINEERING_RULES.md`.
3. Existing local implementation.

Do not use memory or old docs as proof that a model, endpoint, package API, or
provider capability is still current.

## Current Boundaries

- Text and OpenAI-family image calls should go through AI SDK (`generateText`,
  `generateImage`, provider `imageModel`) unless current package types prove the
  SDK cannot express the needed operation.
- Do not add control tools such as `finish`. The agent should use normal AI SDK
  stop conditions plus final text output.
- Keep `streamText` rather than `ToolLoopAgent` while the run needs explicit
  deterministic actions, canvas snapshots, artifact aggregation, and custom
  step streaming.
- `AssistantChatTransport` is the assistant-ui boundary. Custom transport code
  should only attach product context such as session, selected layer, generation
  options, masks, or deterministic actions.
- Fal and Replicate image generation may keep their queue/poll clients. They
  currently carry provider-specific body shapes, reference-image compression,
  polling deadlines, URL downloads, and error mapping that AI SDK does not own
  in this project.
- Tauri desktop, Konva canvas persistence, local engine sidecars, and local media
  storage are product boundaries. Reuse the existing wrappers instead of adding
  parallel abstractions.
- `ai:freshness` is a governance gate. Keep exact model ids, source URLs, and
  checked dates explicit; URL probes may use a curl fallback only after Node
  fetch fails.

## Audit Checklist

Before merging SDK-facing changes:

1. Confirm the real date and read current official docs or installed package
   types for the exact API being changed.
2. Search for direct REST calls that the installed SDK can now replace.
3. Search for local caches, retries, timeouts, sentinels, and protocol wrappers
   that duplicate SDK behavior.
4. Keep custom code only when it enforces a product boundary: BYOK resolution,
   local-first routing, canvas/session ownership, provider-specific queue
   semantics, artifact persistence, or user-visible error normalization.
5. Run the repo gates that match the touched surface, including `ai:freshness`
   for model/provider/catalog changes.
