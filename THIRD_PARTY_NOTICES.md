# Third-Party Notices

Lunery Lab Studio is built on top of an enormous body of open-source work. This
file lists the major projects we integrate, their licenses, and links to the
upstream source. Smaller transitive npm and Cargo dependencies are not
enumerated here; consult their package metadata and source distributions for
their complete license terms.

If you maintain one of these projects and would like attribution corrected or
expanded, please open an issue.

License acceptance:
- We integrate only projects under permissive licenses: **MIT, Apache-2.0,
  BSD-2/3-Clause, MPL-2.0, ISC**.
- We deliberately do **not** bundle GPL / AGPL / SSPL / CC-BY-NC code.
- A handful of high-quality models ship under non-redistributable community
  licenses (Stability AI Community License, Hunyuan Community License). When
  the user opts into those, they are downloaded directly from the model
  provider's host (Hugging Face / provider API) — never re-distributed by us.

---

## Bundled engine sidecars

These are the executable engines distributed with desktop installers. Their
pinned upstream license texts ship in `engine/licenses/` inside the application
resources.

| Project | License | Used for |
| --- | --- | --- |
| [llama.cpp](https://github.com/ggml-org/llama.cpp) | MIT | Local LLM inference (planner agent, text tools). |
| [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp) | MIT | Local image generation (SDXL / SD1.5 / FLUX backbone). |
| [SwiftLM](https://github.com/SharpAI/SwiftLM) | MIT | Apple Silicon local LLM server built with Swift and MLX. |

## Foundational AI runtime libraries (model execution)

| Project | License | Used for |
| --- | --- | --- |
| [Apple MLX](https://github.com/ml-explore/mlx) | MIT | Apple Silicon LLM / image inference (Qwen-MLX, future mflux). |
| [mflux](https://github.com/filipstrand/mflux) | MIT | (planned) FLUX-MLX image sidecar for Apple Silicon. |

## AI SDKs & agent framework

| Project | License | Used for |
| --- | --- | --- |
| [Vercel AI SDK (`ai`, `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/openai-compatible`)](https://github.com/vercel/ai) | Apache-2.0 | Agent loop, multi-step tool calling, structured output, BYOK provider clients. |

## Web framework & UI

| Project | License | Used for |
| --- | --- | --- |
| [Next.js](https://github.com/vercel/next.js) | MIT | App Router, route handlers, server components. |
| [React](https://github.com/facebook/react) | MIT | UI runtime. |
| [Tailwind CSS](https://github.com/tailwindlabs/tailwindcss) | MIT | Styling. |
| [shadcn/ui](https://github.com/shadcn-ui/ui) | MIT | UI primitives (sourced + adapted into our tree). |
| [Radix UI](https://github.com/radix-ui/primitives) | MIT | Accessible UI primitives. |
| [Lucide](https://github.com/lucide-icons/lucide) | ISC | Icon set. |
| [Framer Motion](https://github.com/motiondivision/motion) | MIT | Animation. |
| [Konva](https://github.com/konvajs/konva) / [react-konva](https://github.com/konvajs/react-konva) | MIT | Focused canvas asset editor, transforms, masks, and viewport controls. |
| [`<model-viewer>`](https://github.com/google/model-viewer) | Apache-2.0 | (planned) Inline GLB / USDZ preview for 3D assets. |

## Image / media processing

| Project | License | Used for |
| --- | --- | --- |
| [sharp](https://github.com/lovell/sharp) | Apache-2.0 | Server-side resize, crop, composite, JPEG/WebP encoding, mask building. |
| [BiRefNet](https://github.com/ZhengPeng7/BiRefNet) | MIT | BYOK via fal background removal. Last verified 2026-06-02. |
| [RMBG-2.0](https://huggingface.co/briaai/RMBG-2.0) | Apache-2.0 | Optional BYOK alternative background removal; not a default. Last verified 2026-06-02. |
| [Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) | BSD-3-Clause | Optional BYOK image upscaling; not a default. Last verified 2026-06-02. |
| [Segment Anything 2](https://github.com/facebookresearch/segment-anything-2) | Apache-2.0 | Planned smart auto-mask in canvas; not shipped. Last verified 2026-06-02. |

## Image / video / 3D model providers (BYOK targets)

These are commercial APIs the user can connect through Settings. The user
holds their own key and pays the provider directly.

| Provider | Modality | License of client code |
| --- | --- | --- |
| OpenAI | text + image (GPT Image; DALL·E retained only as deprecated compatibility if a user explicitly configures it) | Apache-2.0 (`@ai-sdk/openai`) |
| Anthropic | text | Apache-2.0 (`@ai-sdk/anthropic`) |
| Google Gemini | text + image | Apache-2.0 (`@ai-sdk/google`) |
| OpenRouter | text | Apache-2.0 (`@ai-sdk/openai-compatible`) |
| MiniMax | text + video | Internal HTTP client (MIT, in this repo). |
| Replicate | image / image-edit / video / 3D | Internal HTTP client (MIT, in this repo). |
| fal | image / image-edit / video / 3D | Internal HTTP client (MIT, in this repo). |
| Together AI | text + image | Apache-2.0 (`@ai-sdk/openai-compatible`). |
| Fireworks | text + image | Apache-2.0 (`@ai-sdk/openai-compatible`). |
| Meshy | 3D model | Internal HTTP client (MIT, in this repo). |
| Tripo | 3D model | Internal HTTP client (MIT, in this repo). |

## Open-source AI models retained for local / compatibility use

| Model | License | Used for |
| --- | --- | --- |
| [FLUX.1-schnell](https://huggingface.co/second-state/FLUX.1-schnell-GGUF) | Apache-2.0 | Local text-to-image compatibility kit. Current upstream BFL image work has moved to FLUX.2; this row stays only because it is the shipped sd-cpp path. Last verified 2026-06-02. |
| [SDXL Base 1.0](https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0) | OpenRAIL++ | Legacy local text-to-image baseline. Last verified 2026-06-02. |
| [Stable Diffusion 1.5](https://huggingface.co/Comfy-Org/stable-diffusion-v1-5-archive) | OpenRAIL | Legacy low-footprint local image compatibility path. Last verified 2026-06-02. |
| [Qwen 2.5 7B GGUF](https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF) | Apache-2.0 | Local planner LLM compatibility path. Current official Qwen generation is Qwen3; Qwen2.5 is no longer recommended by default. Last verified 2026-06-02. |
| [Llama 3.2 3B Instruct GGUF](https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF) | Llama 3.2 Community License | Low-RAM local planner LLM compatibility path. Current official Meta org includes Llama 4 models, but they are not this app's single-file GGUF path. Last verified 2026-06-02. |
| [TripoSR](https://github.com/VAST-AI-Research/TripoSR) | MIT | Legacy/reference image-to-3D implementation; not a current default because 3D generation uses explicit BYOK provider operations. Last verified 2026-06-02. |
| [InstantMesh](https://github.com/TencentARC/InstantMesh) | Apache-2.0 | Planned/future local image-to-3D reference; not shipped. Last verified 2026-06-02. |
| [TRELLIS](https://github.com/Microsoft/TRELLIS) | MIT | Planned/future local image-to-3D reference; not shipped. Last verified 2026-06-02. |
| [Wan 2.1](https://huggingface.co/Wan-AI/Wan2.1-T2V-1.3B-Diffusers) | Apache-2.0 | Legacy/compatibility video reference only; video generation uses explicit BYOK provider model IDs configured by the user. Last verified 2026-06-02. |
| [LTX-Video](https://huggingface.co/Lightricks/LTX-Video) | LTXV OpenRail-M (commercial use restricted) | Legacy/reference text-to-video model; not bundled and not recommended by default. Last verified 2026-06-02. |

## Desktop shell

| Project | License | Used for |
| --- | --- | --- |
| [Tauri 2](https://github.com/tauri-apps/tauri) | MIT / Apache-2.0 | Cross-platform desktop wrapper, sidecar lifecycle, OS keychain bridge. |
| [@tauri-apps/api](https://github.com/tauri-apps/tauri) | MIT / Apache-2.0 | Tauri client SDK. |

## Data + storage

| Project | License | Used for |
| --- | --- | --- |
| [Prisma](https://github.com/prisma/prisma) | Apache-2.0 | ORM + schema migrations. |
| [PostgreSQL](https://www.postgresql.org/) | PostgreSQL License | Application database. |
| [zod](https://github.com/colinhacks/zod) | MIT | Runtime schema validation. |
| [@vercel/blob](https://github.com/vercel/storage) | Apache-2.0 | Optional cloud asset storage. |

## Tooling

| Project | License | Used for |
| --- | --- | --- |
| [TypeScript](https://github.com/microsoft/TypeScript) | Apache-2.0 | Language. |
| [ESLint](https://github.com/eslint/eslint) | MIT | Linting. |
| [pnpm](https://github.com/pnpm/pnpm) | MIT | Package manager. |

---

## How attribution updates work

This file is hand-curated for major dependencies. The three pinned sidecar fetch
scripts refresh their matching license files from the exact upstream release
tag. `pnpm licenses:check` verifies that those files are present and non-empty,
and that the bundled component list above matches `scripts/sidecar-manifest.json`.
Tauri packages both the license directory and this notice with the application.

---

*Built on the shoulders of giants. Thank you to every maintainer above.*
