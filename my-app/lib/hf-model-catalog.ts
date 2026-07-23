import type { HardwareInfo } from "@/lib/desktop-runtime";

// ---------------------------------------------------------------------------
// SHA-256 maintenance notes
//
// Single-file GGUF / safetensors entries below carry the upstream Hugging Face
// `x-linked-etag` (which IS the SHA-256 of the LFS-stored file). To refresh
// after upstream re-uploads:
//
//   curl -sLI "<downloadUrl>" | grep -i x-linked-etag
//
// moondream2 removed in Package E (2026-05-20). Its catalog row had
// runtimeTarget:"ollama" with a raw .gguf downloadUrl that Ollama cannot use.
// Restore after `bridge_ollama_pull()` lands (requires finding the `ollama`
// binary cross-platform + an async exec bridge command).
//
// Freshness baseline: 2026-07-23.
// Every catalog row is a currently supported product option and must be both
// available upstream and runnable through the shipped desktop bridge. Product
// support is not inferred from whether a model is the newest member of its
// upstream family: smaller older models remain visible when they are the right
// fit for lower-memory hardware.
// ---------------------------------------------------------------------------

export type ModelCapability = "planner-llm" | "vision" | "image-gen";
export type ModelFormat = "gguf" | "diffusers";
export type ModelRuntimeTarget = "llama-cpp" | "sd-cpp" | "ollama" | "lm-studio" | "comfyui";
export const MODEL_FRESHNESS_BASELINE = "2026-07-23";

export interface ModelSourceEvidence {
  label: string;
  url: string;
  lastVerifiedAt: string;
}

export interface HfModelEntry {
  /** Stable internal id (never changes once published). */
  id: string;
  /** Exact upstream repository for this downloadable leaf model. */
  sourceUrl: string;
  /** Date this exact leaf and its download metadata were last checked. */
  checkedAt: string;
  capability: ModelCapability;
  label: string;
  hfRepo: string;
  /** Primary file name within the HF repo. */
  fileName: string;
  format: ModelFormat;
  /** Approximate download size in bytes (GB × 1 073 741 824). */
  sizeBytes: number;
  /**
   * Expected SHA-256 hex digest of the downloaded file.
   * null = verification optional (UI shows a warning but download proceeds).
   */
  sha256: string | null;
  /** Minimum system RAM required to run the model (GiB). */
  minRamGb: number;
  /** True if the model only runs on Apple Silicon. */
  requiresAppleSilicon: boolean;
  runtimeTarget: ModelRuntimeTarget;
  /** Search and filter terms that describe real user intent, not just filenames. */
  searchAliases: readonly string[];
  /** Marks the default recommendation for a capability on compatible hardware. */
  recommended: boolean;
  sourceEvidence: readonly ModelSourceEvidence[];
  freshnessExpiresAt: string;
  freshnessNote: string;
  /** Short stable tag IDs used by the UX layer. */
  useCaseTags: readonly string[];
  speedTier: "fast" | "balanced" | "quality";
  offlineReady: boolean;
  /**
   * Direct URL for the primary downloadable file.
   */
  downloadUrl: string;
  /**
   * Extra files that must sit next to the primary file for the model to run
   * (FLUX.1 needs a VAE + CLIP-L + T5-XXL; FLUX.2 needs a decoder/VAE + LLM).
   * Optional — single-file models omit it entirely. Each companion downloads
   * into the same visible Lunery profile models/<runtimeTarget>/ directory
   * under its own fileName, so the runtime finds it without path translation.
   */
  companions?: ReadonlyArray<{
    fileName: string;
    downloadUrl: string;
    sizeBytes: number;
    sha256: string | null;
  }>;
}

/** 1 GiB expressed as bytes. */
const GiB = 1_073_741_824;

export const HF_MODEL_CATALOG = [
  {
    id: "qwen3.6-35b-a3b-ud-q4-k-m",
    sourceUrl: "https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF",
    checkedAt: MODEL_FRESHNESS_BASELINE,
    capability: "planner-llm",
    label: "Qwen3.6 35B-A3B (UD-Q4_K_M GGUF)",
    hfRepo: "unsloth/Qwen3.6-35B-A3B-GGUF",
    fileName: "Qwen3.6-35B-A3B-UD-Q4_K_M.gguf",
    format: "gguf",
    sizeBytes: 22_134_528_992,
    sha256: "ac0e2c1189e055faa36eff361580e79c5bd6f8e76bffb4ce547f167d53e31a61",
    minRamGb: 48,
    requiresAppleSilicon: false,
    runtimeTarget: "llama-cpp",
    searchAliases: ["qwen3.6", "qwen", "hot", "popular", "current", "text", "planner", "chat", "reasoning", "gguf", "offline"],
    recommended: true,
    sourceEvidence: [
      {
        label: "Qwen official Qwen3.6-35B-A3B model card",
        url: "https://huggingface.co/Qwen/Qwen3.6-35B-A3B",
        lastVerifiedAt: MODEL_FRESHNESS_BASELINE,
      },
      {
        label: "High-download GGUF quantization used by this catalog",
        url: "https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF",
        lastVerifiedAt: MODEL_FRESHNESS_BASELINE,
      },
    ],
    freshnessExpiresAt: "2026-08-22",
    freshnessNote:
      "Current Qwen MoE row verified from the official model card and the shipped GGUF release on 2026-07-23.",
    useCaseTags: ["text", "planner", "current"],
    speedTier: "quality",
    offlineReady: true,
    downloadUrl:
      "https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF/resolve/main/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf",
  },
  {
    id: "qwen3.6-27b-q4",
    sourceUrl: "https://huggingface.co/unsloth/Qwen3.6-27B-GGUF",
    checkedAt: MODEL_FRESHNESS_BASELINE,
    capability: "planner-llm",
    label: "Qwen3.6 27B (Q4_K_M GGUF)",
    hfRepo: "unsloth/Qwen3.6-27B-GGUF",
    fileName: "Qwen3.6-27B-Q4_K_M.gguf",
    format: "gguf",
    sizeBytes: 16_817_244_384,
    sha256: "5ed60d0af4650a854b1755bd392f9aef4872643dc25a254bc68043fa638392a0",
    minRamGb: 32,
    requiresAppleSilicon: false,
    runtimeTarget: "llama-cpp",
    searchAliases: ["qwen3.6", "qwen", "current", "text", "planner", "chat", "reasoning", "gguf", "offline"],
    recommended: true,
    sourceEvidence: [
      {
        label: "Qwen official Qwen3.6-27B model card",
        url: "https://huggingface.co/Qwen/Qwen3.6-27B",
        lastVerifiedAt: MODEL_FRESHNESS_BASELINE,
      },
      {
        label: "Current GGUF quantization used by this catalog",
        url: "https://huggingface.co/unsloth/Qwen3.6-27B-GGUF",
        lastVerifiedAt: MODEL_FRESHNESS_BASELINE,
      },
    ],
    freshnessExpiresAt: "2026-08-22",
    freshnessNote:
      "Current Qwen text family row kept for machines that cannot reasonably fit the hotter MoE variant.",
    useCaseTags: ["text", "planner", "current"],
    speedTier: "quality",
    offlineReady: true,
    downloadUrl:
      "https://huggingface.co/unsloth/Qwen3.6-27B-GGUF/resolve/main/Qwen3.6-27B-Q4_K_M.gguf",
  },
  {
    id: "deepseek-v4-flash-iq2xxs",
    sourceUrl: "https://huggingface.co/antirez/deepseek-v4-gguf",
    checkedAt: MODEL_FRESHNESS_BASELINE,
    capability: "planner-llm",
    label: "DeepSeek V4 Flash (IQ2XXS GGUF)",
    hfRepo: "antirez/deepseek-v4-gguf",
    fileName: "DeepSeek-V4-Flash-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8-chat-v2-imatrix.gguf",
    format: "gguf",
    sizeBytes: 86_720_111_488,
    sha256: "efc7ed607ff27076e3e501fc3fefefa33c0ed8cf1eff483a2b7fdc0c2e616668",
    minRamGb: 128,
    requiresAppleSilicon: false,
    runtimeTarget: "llama-cpp",
    searchAliases: ["deepseek", "deepseek v4", "v4 flash", "hot", "popular", "current", "text", "planner", "reasoning", "gguf", "offline"],
    recommended: false,
    sourceEvidence: [
      {
        label: "DeepSeek official V4 Flash model card",
        url: "https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash",
        lastVerifiedAt: MODEL_FRESHNESS_BASELINE,
      },
      {
        label: "High-download DeepSeek V4 GGUF quantization used by this catalog",
        url: "https://huggingface.co/antirez/deepseek-v4-gguf",
        lastVerifiedAt: MODEL_FRESHNESS_BASELINE,
      },
    ],
    freshnessExpiresAt: "2026-08-22",
    freshnessNote:
      "Hot current DeepSeek row kept as a high-memory option; it is not recommended on ordinary laptops because the verified single-file GGUF is 80GB+.",
    useCaseTags: ["text", "current", "quality"],
    speedTier: "quality",
    offlineReady: true,
    downloadUrl:
      "https://huggingface.co/antirez/deepseek-v4-gguf/resolve/main/DeepSeek-V4-Flash-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8-chat-v2-imatrix.gguf",
  },
  {
    id: "flux2-dev-q4",
    sourceUrl: "https://huggingface.co/unsloth/FLUX.2-dev-GGUF",
    checkedAt: MODEL_FRESHNESS_BASELINE,
    capability: "image-gen",
    label: "FLUX.2 Dev (Q4_K_M GGUF)",
    hfRepo: "unsloth/FLUX.2-dev-GGUF",
    fileName: "flux2-dev-Q4_K_M.gguf",
    format: "gguf",
    // Whole runnable kit: diffusion model + public FLUX.2 small decoder +
    // Mistral text encoder. The official FLUX.2 VAE file is gated, so the
    // catalog uses the public decoder path documented by stable-diffusion.cpp.
    sizeBytes: 34_543_173_108,
    sha256: "5f7ac6649e2f5e21a49a6f83931a67530bd887e2d34379c3da1d0f0406501de1",
    minRamGb: 32,
    requiresAppleSilicon: false,
    runtimeTarget: "sd-cpp",
    searchAliases: ["flux2", "flux.2", "flux", "current", "image", "generation", "creator", "gguf", "non-commercial"],
    recommended: false,
    sourceEvidence: [
      {
        label: "Black Forest Labs official FLUX.2-dev model card",
        url: "https://huggingface.co/black-forest-labs/FLUX.2-dev",
        lastVerifiedAt: MODEL_FRESHNESS_BASELINE,
      },
      {
        label: "Current FLUX.2 GGUF quantization used by this catalog",
        url: "https://huggingface.co/unsloth/FLUX.2-dev-GGUF",
        lastVerifiedAt: MODEL_FRESHNESS_BASELINE,
      },
      {
        label: "stable-diffusion.cpp FLUX.2 runtime guide",
        url: "https://github.com/leejet/stable-diffusion.cpp/blob/master/docs/flux2.md",
        lastVerifiedAt: MODEL_FRESHNESS_BASELINE,
      },
    ],
    freshnessExpiresAt: "2026-08-22",
    freshnessNote:
      "Current FLUX.2 image kit verified on 2026-07-23. The official BFL base repo is gated and non-commercial; this row uses public GGUF/decoder/text-encoder files documented for stable-diffusion.cpp.",
    useCaseTags: ["image", "current", "quality"],
    speedTier: "quality",
    offlineReady: true,
    downloadUrl:
      "https://huggingface.co/unsloth/FLUX.2-dev-GGUF/resolve/main/flux2-dev-Q4_K_M.gguf",
    companions: [
      {
        fileName: "full_encoder_small_decoder.safetensors",
        downloadUrl:
          "https://huggingface.co/black-forest-labs/FLUX.2-small-decoder/resolve/main/full_encoder_small_decoder.safetensors",
        sizeBytes: 249_519_092,
        sha256: "ea4273f02d1fafbf8e1d1c2cf6018ed8748652eb0bf34f2dd91171f16f15ab62",
      },
      {
        fileName: "Mistral-Small-3.2-24B-Instruct-2506-Q4_K_M.gguf",
        downloadUrl:
          "https://huggingface.co/unsloth/Mistral-Small-3.2-24B-Instruct-2506-GGUF/resolve/main/Mistral-Small-3.2-24B-Instruct-2506-Q4_K_M.gguf",
        sizeBytes: 14_333_922_848,
        sha256: "a3cc56310807ed0d145eaf9f018ccda9ae7ad8edb41ec870aa2454b0d4700b3c",
      },
    ],
  },
  {
    // Switched from the official Qwen GGUF repo to bartowski because the
    // upstream Q4_K_M was re-sharded into 2 files with no single-file URL,
    // breaking the existing downloadUrl with a 404. bartowski's variant is a
    // single 4.36 GiB file with a stable SHA-256.
    id: "qwen2.5-7b-instruct-q4",
    sourceUrl: "https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF",
    checkedAt: MODEL_FRESHNESS_BASELINE,
    capability: "planner-llm",
    label: "Qwen 2.5 7B Instruct (Q4)",
    hfRepo: "bartowski/Qwen2.5-7B-Instruct-GGUF",
    fileName: "Qwen2.5-7B-Instruct-Q4_K_M.gguf",
    format: "gguf",
    sizeBytes: 4_683_074_240,
    sha256: "65b8fcd92af6b4fefa935c625d1ac27ea29dcb6ee14589c55a8f115ceaaa1423",
    minRamGb: 8,
    requiresAppleSilicon: false,
    runtimeTarget: "llama-cpp",
    searchAliases: ["qwen", "text", "planner", "chat", "reasoning", "balanced", "gguf", "offline"],
    recommended: false,
    sourceEvidence: [
      {
        label: "Qwen official Qwen2.5-7B-Instruct model card",
        url: "https://huggingface.co/Qwen/Qwen2.5-7B-Instruct",
        lastVerifiedAt: MODEL_FRESHNESS_BASELINE,
      },
      {
        label: "Current runnable GGUF quantization used by this catalog",
        url: "https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF",
        lastVerifiedAt: MODEL_FRESHNESS_BASELINE,
      },
    ],
    freshnessExpiresAt: "2026-08-22",
    freshnessNote:
      "Supported low-memory llama.cpp option for machines that cannot run the larger Qwen3.6 rows.",
    useCaseTags: ["text", "planner", "balanced"],
    speedTier: "balanced",
    offlineReady: true,
    downloadUrl:
      "https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf",
  },
  {
    id: "llama-3.2-3b-instruct-q4",
    sourceUrl: "https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF",
    checkedAt: MODEL_FRESHNESS_BASELINE,
    capability: "planner-llm",
    label: "Llama 3.2 3B Instruct (Q4)",
    hfRepo: "bartowski/Llama-3.2-3B-Instruct-GGUF",
    fileName: "Llama-3.2-3B-Instruct-Q4_K_M.gguf",
    format: "gguf",
    sizeBytes: Math.round(2.0 * GiB),
    sha256: "6c1a2b41161032677be168d354123594c0e6e67d2b9227c84f296ad037c728ff",
    minRamGb: 4,
    requiresAppleSilicon: false,
    runtimeTarget: "llama-cpp",
    searchAliases: ["llama", "small", "fast", "low ram", "4gb", "text", "planner", "gguf", "offline"],
    recommended: false,
    sourceEvidence: [
      {
        label: "Meta official Llama-3.2-3B-Instruct model card",
        url: "https://huggingface.co/meta-llama/Llama-3.2-3B-Instruct",
        lastVerifiedAt: MODEL_FRESHNESS_BASELINE,
      },
      {
        label: "Current runnable GGUF quantization used by this catalog",
        url: "https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF",
        lastVerifiedAt: MODEL_FRESHNESS_BASELINE,
      },
    ],
    freshnessExpiresAt: "2026-08-22",
    freshnessNote:
      "Supported low-memory llama.cpp option for machines where larger planner models do not fit.",
    useCaseTags: ["text", "low-ram", "fast"],
    speedTier: "fast",
    offlineReady: true,
    downloadUrl:
      "https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf",
  },
  {
    id: "flux1-schnell-q4",
    sourceUrl: "https://huggingface.co/second-state/FLUX.1-schnell-GGUF",
    checkedAt: MODEL_FRESHNESS_BASELINE,
    capability: "image-gen",
    label: "FLUX.1 Schnell (Q4 + companions)",
    hfRepo: "second-state/FLUX.1-schnell-GGUF",
    fileName: "flux1-schnell-Q4_0.gguf",
    format: "gguf",
    // Full FLUX kit on disk = diffusion model + VAE + CLIP-L + T5-XXL(fp16),
    // all from ONE non-gated repo (second-state, Apache-2.0, gated:false).
    // ≈ 6.69 + 0.246 + 0.335 + 9.79 GiB. Used for the disk-space pre-check
    // and the size shown in the catalog row.
    sizeBytes: Math.round(17.06 * GiB),
    sha256: "b338a7ab5c81600a54be46c4cf950edb3761a52ae163e419beafd250976fb566",
    minRamGb: 12,
    requiresAppleSilicon: false,
    runtimeTarget: "sd-cpp",
    searchAliases: ["flux", "image", "generation", "quality", "creator", "object", "schnell", "offline"],
    recommended: false,
    sourceEvidence: [
      {
        label: "Black Forest Labs official FLUX.1-schnell model card",
        url: "https://huggingface.co/black-forest-labs/FLUX.1-schnell",
        lastVerifiedAt: MODEL_FRESHNESS_BASELINE,
      },
      {
        label: "Current runnable FLUX.1 GGUF kit used by this catalog",
        url: "https://huggingface.co/second-state/FLUX.1-schnell-GGUF",
        lastVerifiedAt: MODEL_FRESHNESS_BASELINE,
      },
    ],
    freshnessExpiresAt: "2026-08-22",
    freshnessNote:
      "Supported faster image-generation kit for machines that cannot fit the FLUX.2 row.",
    useCaseTags: ["image", "quality", "object"],
    speedTier: "quality",
    offlineReady: true,
    downloadUrl:
      "https://huggingface.co/second-state/FLUX.1-schnell-GGUF/resolve/main/flux1-schnell-Q4_0.gguf",
    companions: [
      {
        fileName: "ae.safetensors",
        downloadUrl:
          "https://huggingface.co/second-state/FLUX.1-schnell-GGUF/resolve/main/ae.safetensors",
        sizeBytes: Math.round(0.335 * GiB),
        sha256: "afc8e28272cd15db3919bacdb6918ce9c1ed22e96cb12c4d5ed0fba823529e38",
      },
      {
        fileName: "clip_l.safetensors",
        downloadUrl:
          "https://huggingface.co/second-state/FLUX.1-schnell-GGUF/resolve/main/clip_l.safetensors",
        sizeBytes: Math.round(0.246 * GiB),
        sha256: "660c6f5b1abae9dc498ac2d21e1347d2abdb0cf6c0c0c8576cd796491d9a6cdd",
      },
      {
        fileName: "t5xxl_fp16.safetensors",
        downloadUrl:
          "https://huggingface.co/second-state/FLUX.1-schnell-GGUF/resolve/main/t5xxl_fp16.safetensors",
        sizeBytes: Math.round(9.79 * GiB),
        sha256: "6e480b09fae049a72d2a8c5fbccb8d3e92febeb233bbe9dfe7256958a9167635",
      },
    ],
  },
  {
    id: "sdxl-base-1.0",
    sourceUrl: "https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0",
    checkedAt: MODEL_FRESHNESS_BASELINE,
    capability: "image-gen",
    label: "SDXL Base 1.0",
    hfRepo: "stabilityai/stable-diffusion-xl-base-1.0",
    fileName: "sd_xl_base_1.0.safetensors",
    format: "diffusers",
    sizeBytes: Math.round(6.9 * GiB),
    sha256: "31e35c80fc4829d14f90153f4c74cd59c90b779f6afe05a74cd6120b893f7e5b",
    minRamGb: 12,
    requiresAppleSilicon: false,
    runtimeTarget: "sd-cpp",
    searchAliases: ["sdxl", "image", "generation", "quality", "stable diffusion", "offline"],
    recommended: false,
    sourceEvidence: [
      {
        label: "Stability AI SDXL Base 1.0 model card",
        url: "https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0",
        lastVerifiedAt: MODEL_FRESHNESS_BASELINE,
      },
    ],
    freshnessExpiresAt: "2026-08-22",
    freshnessNote:
      "Supported SDXL baseline for broad style coverage and lower memory requirements than FLUX.2.",
    useCaseTags: ["image", "quality", "stable"],
    speedTier: "quality",
    offlineReady: true,
    downloadUrl:
      "https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors",
  },
  {
    id: "sd15-emaonly",
    sourceUrl: "https://huggingface.co/Comfy-Org/stable-diffusion-v1-5-archive",
    checkedAt: MODEL_FRESHNESS_BASELINE,
    capability: "image-gen",
    label: "Stable Diffusion 1.5 (ema-only fp16)",
    hfRepo: "Comfy-Org/stable-diffusion-v1-5-archive",
    fileName: "v1-5-pruned-emaonly-fp16.safetensors",
    format: "diffusers",
    sizeBytes: 2_132_696_762,
    sha256: "e9476a13728cd75d8279f6ec8bad753a66a1957ca375a1464dc63b37db6e3916",
    minRamGb: 6,
    requiresAppleSilicon: false,
    runtimeTarget: "sd-cpp",
    searchAliases: ["sd15", "stable diffusion", "image", "fast", "low ram", "safetensors", "offline"],
    recommended: false,
    sourceEvidence: [
      {
        label: "Comfy archive of Stable Diffusion 1.5 safetensors",
        url: "https://huggingface.co/Comfy-Org/stable-diffusion-v1-5-archive",
        lastVerifiedAt: MODEL_FRESHNESS_BASELINE,
      },
    ],
    freshnessExpiresAt: "2026-08-22",
    freshnessNote:
      "Supported low-memory Stable Diffusion option for hardware where larger image models do not fit.",
    useCaseTags: ["image", "low-ram", "fast"],
    speedTier: "fast",
    offlineReady: true,
    downloadUrl:
      "https://huggingface.co/Comfy-Org/stable-diffusion-v1-5-archive/resolve/main/v1-5-pruned-emaonly-fp16.safetensors",
  },
] as const satisfies HfModelEntry[];

export type ModelRunnableState =
  | "not_downloaded"
  | "downloaded"
  | "missing_runtime"
  | "hardware_unfit";

/**
 * Pure helper — derives all four runnable states for a catalog entry.
 *
 * State priority (evaluated in order):
 *   1. "hardware_unfit"   — hw present AND (Apple Silicon required but absent, OR RAM too low).
 *   2. "not_downloaded"   — hardware is fit (or unknown) but file is not yet on disk.
 *   3. "missing_runtime"  — file is downloaded but the required runtime is explicitly unavailable.
 *   4. "downloaded"       — file present and runtime is available (or its state is unknown).
 *
 * @param entry            - The catalog entry to evaluate.
 * @param hw               - Current hardware snapshot (null → not yet loaded; hardware assumed fit).
 * @param downloaded       - Whether the model file is confirmed present on disk.
 * @param runtimeAvailable - Optional runtime-probe result for the entry's `runtimeTarget`.
 *                           `true`  = runtime reachable (or assumed so when omitted).
 *                           `false` = runtime explicitly known-unavailable → "missing_runtime".
 *                           `undefined` = runtime state not yet known → treated as available
 *                                         (caller must not coerce unknown to false).
 *                           Supplied by the Local Models panel from its runtime probe; omit
 *                           when runtime state is genuinely unknown.
 */
export function modelRunnableState(
  entry: HfModelEntry,
  hw: Pick<HardwareInfo, "ram_gb" | "apple_silicon"> | null,
  downloaded: boolean,
  runtimeAvailable?: boolean,
): ModelRunnableState {
  if (hw !== null) {
    if (entry.requiresAppleSilicon && !hw.apple_silicon) return "hardware_unfit";
    if (hw.ram_gb < entry.minRamGb) return "hardware_unfit";
  }
  if (!downloaded) return "not_downloaded";
  if (runtimeAvailable === false) return "missing_runtime";
  return "downloaded";
}

/** Lookup by id — returns undefined for unknown ids. */
export function findHfModelEntry(id: string): HfModelEntry | undefined {
  return HF_MODEL_CATALOG.find((entry) => entry.id === id);
}

type HardwareFitInput = Pick<HardwareInfo, "ram_gb" | "apple_silicon"> | null;

/**
 * Single source of "does this model fit the machine" truth. Treats a
 * present-but-unknown runtime as available so a not-yet-downloaded model is
 * judged purely on hardware. Shared by the Local Models panel's fit checks.
 */
export function fitsHardware(entry: HfModelEntry, hw: HardwareFitInput): boolean {
  return modelRunnableState(entry, hw, true, true) !== "hardware_unfit";
}
