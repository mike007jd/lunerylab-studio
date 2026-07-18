# AI Runtime Rules

Source of truth for LuneryLab's AI runtime topology, model-supply policy, and
desktop architecture. All agent entry files (`CLAUDE.md`, `AGENTS.md`,
`GEMINI.md`) route to this file for AI-related changes.

The product pivoted from platform-funded credits to a local-first desktop
Studio.

Model supply has two explicit layers:
**local model / Hugging Face-first, BYOK second.**

## NO DEFAULT MODEL — empty stays empty (non-negotiable)

- Never hardcode a fallback to a content-generation model the user did not
  choose. There is no `DEFAULT_MODEL_ID`, no silent `dall-e-3`/`gpt-image-1`/
  `gpt-4o-mini`/`flux-2-flex` substitution, and no auto-routing to a platform
  cloud model when nothing is configured.
- If no model is selected or connected, surface a clear "pick or connect a
  model in Settings" error / disabled UI — do not guess.
- A BYOK provider that produces user-facing content sets
  `requiresModelId: true` so the connection form forces an explicit model id.
- The only exemption is a provider whose "model" is a single fixed operation
  mode, not a user choice (Meshy `image-to-3d`, Tripo `image_to_model`).
- Catalog/pickers may pre-select the first *actually-available* model — never
  an invented constant.
- Rationale: this is a local-first / BYOK / account-less product, and every
  hardcoded model string eventually goes stale or dead (DALL·E shut down
  2026-05-12) and silently fails the user.
- **Enforcement**: wired into ESLint as `no-restricted-syntax` in
  `my-app/eslint.config.mjs`. Violations are caught at lint time, not in
  review. Adding a model-id literal outside the BYOK catalog or server
  dispatch paths will fail CI.

## Runtime layers

- **Local-first runtime (primary path).** Studio routes generation/agent calls
  through a local runtime broker: Ollama, LM Studio, llama.cpp server, MLX
  server, OpenAI-compatible local endpoint, ComfyUI / Diffusers / SD-Flux local
  workflow. Hugging Face model discovery → curated list → download (resume,
  disk check, checksum, hardware-fit, runnable-state, retry) is a first-class
  in-product capability. Local runtime adapters are expected, not forbidden.
- **BYOK (second path) — REQUIRED.** Users connect their own credentials:
  OpenAI, Anthropic, Google Gemini, OpenRouter, MiniMax, Replicate / Fal /
  Together / Fireworks, and any OpenAI-compatible endpoint (API key / bearer /
  OAuth / base URL + model id / localhost). A BYOK provider-connection
  settings UI is a product requirement. Keys NEVER flow through a
  platform-hosted generation chain — desktop stores them in the OS keychain
  (`/api/desktop-runtime/provider-secret`); self-host uses deployer env.
- **No platform-funded gateway layer.** Generation resolves only through a
  user-installed local runtime or an explicitly configured BYOK connection.
  The agent routes by capability and never falls back to a platform model.
- **No China mainland deployment requirement.** No China-specific direct
  providers, China region storage, or ICP filing.

## Desktop / local-first architecture

- Desktop shell is **Tauri 2** (`my-app/src-tauri/`). On launch it starts a
  private `127.0.0.1` Next server and sets `LUNERY_DESKTOP=1` to unlock
  Studio.
- `proxy.ts` redirects browser requests for workbench routes (`/studio`,
  `/tools`, `/library`, `/workflow-kits`, `/settings`, `/billing`, `/canvas`)
  to `https://www.lunerylab.com/download`; only the desktop WebView
  (`LUNERY_DESKTOP`) may open Studio.
- Landing, `/download`, legal, showcase, SEO, analytics, and website deployment
  are maintained separately from this desktop repository.
  Never re-introduce an online Studio. Billing / credits /
  license-key / Pro / team-tier semantics are fully retired — any remaining
  `/billing` or `/license` files are vestigial and should not be built on.
- Desktop runtime bridge: Next API ↔ Tauri/Rust. Status via
  `/api/desktop-runtime/status`, secrets via
  `/api/desktop-runtime/provider-secret`, client helper
  `lib/desktop-runtime.ts`, Settings surface
  `components/settings/desktop-runtime-card.tsx`. Reuse this bridge; do not
  invent a parallel one.
- Desktop-owned local files live under a visible Lunery profile, not opaque OS
  app-data defaults. Packaged/current desktop defaults to `~/.lunerylab/studio`;
  local desktop dev defaults to `~/.lunerylab/studio-dev`. The profile shape is
  `config/`, `data/pglite/`, `data/media/`, `models/`, `logs/`, and
  `runtime/`. New writes must use `LUNERY_HOME` / `LUNERY_CONFIG_DIR` /
  `LUNERY_DATA_DIR` / `LUNERY_PGLITE_DIR` / `ECOM_STORAGE_DIR` /
  `LUNERY_MODELS_DIR` / `LUNERY_LOG_DIR` / `LUNERY_RUNTIME_DIR` as resolved by
  `my-app/lib/server/lunery-profile.ts` and `my-app/src-tauri/src/profile.rs`.
  Legacy locations (`~/Library/Application Support/com.lunerylab.studio`,
  `~/Library/Logs/com.lunerylab.studio`, `my-app/.desktop-dev`, `my-app/data`,
  and `~/.cache/lunerylab/models`) are migration/compatibility sources only;
  do not add new default writes there.

## Product positioning (informs all AI decisions)

- LuneryLab Studio = a Lovart-style AI creative Studio for **overseas
  creators** (general — not vertical). The prior "overseas e-commerce
  creator" framing is retired (2026-05-20). Do NOT use "e-commerce / product
  image / listing / ad creative / brand kit" copy, task intents, or agent
  prompts. Stay broad-creator until a vertical earns its keep with real
  capability.
- Do NOT regress Studio into a generic canvas, a model manager, or a
  Jan/Osaurus-style chat shell. Model management is a Settings capability
  layer, never the main surface.
- Two runtime forms: **Web = marketing + distribution only**;
  **Desktop (Tauri 2) = the real Studio.**
- Primary surface: image generation (high frequency). Video is secondary
  (low frequency, expensive — keep choices few).
- **Free, MIT open-source, single-user, account-less.** No monetization
  layer — no Pro / team license / billing / credits / license-key. Do not
  reintroduce a paid-tier UX.
- Avoid enterprise / power-user features unless explicitly requested.
- Auto-update: not wired. See `docs/adr/0001-no-auto-update.md`.
