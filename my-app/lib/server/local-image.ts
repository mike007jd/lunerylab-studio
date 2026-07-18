/**
 * Local image generation client — routes requests to a ComfyUI instance
 * running at `endpoint` (default: http://127.0.0.1:8188).
 *
 * The return type is the shared GenerateImageResult
 * so the seam in image-generate.ts is type-transparent.
 *
 * ComfyUI workflow notes:
 *   - The txt2img graph below loads the selected local checkpoint by file name.
 *     Imported ComfyUI models must already be visible to ComfyUI's checkpoint
 *     loader.
 *   - Sampler settings (steps / cfg / sampler / scheduler / native resolution)
 *     are chosen per model FAMILY (FLUX-schnell, FLUX-dev, SDXL, SD1.5), not
 *     hardcoded to a single FLUX-schnell assumption. Unknown families are
 *     rejected before a workflow reaches ComfyUI.
 *   - Output dimensions honor the shared `aspectRatio` (same ratio table as the
 *     embedded sd.cpp path), scaled from the family's native base resolution.
 *   - `abortSignal` cancels in-flight work: it interrupts the running ComfyUI
 *     job and deletes any still-queued prompt, matching the sd.cpp `/sd-cancel`
 *     behavior — a Stop from the user actually stops the underlying queue.
 *   - Image edit (inpainting/outpainting) is NOT implemented in v1; callers
 *     should fall through to the BYOK edit path.
 *   - ComfyUI's /prompt endpoint queues the job and returns a prompt_id.
 *     We poll /history/{prompt_id} until the job finishes, then fetch the
 *     output image via /view.
 *
 * Live ComfyUI integration test pending — requires a running ComfyUI with a
 * compatible checkpoint. The seam contract (types, HTTP/poll logic, family
 * profiles, aspect ratio, cancellation, error handling) is fully implemented
 * and compile-verified.
 */

import "server-only";
import { ApiError } from "@/lib/server/errors";
import type { GenerateImageInput, GenerateImageResult } from "@/lib/server/generation-types";
import { findHfModelEntry } from "@/lib/hf-model-catalog";
import { findImportedModel } from "@/lib/server/imported-model-registry";
import { localImageDimensions } from "@/lib/server/generation-dimensions";

// ---------------------------------------------------------------------------
// Model-family workflow profiles
// ---------------------------------------------------------------------------
// ComfyUI accepts any imported checkpoint, and different families need very
// different sampler settings. A FLUX-schnell profile (4 steps, cfg 1.0) yields
// garbage on an SDXL or SD1.5 checkpoint, so we classify the checkpoint and pick
// a matching profile instead of assuming one shape for all.

export type ComfyModelFamily = "flux-schnell" | "flux-dev" | "sdxl" | "sd15" | "unknown";

interface ComfyWorkflowProfile {
  steps: number;
  cfg: number;
  samplerName: string;
  scheduler: string;
  /** Native square resolution the family was trained at; aspect ratio scales from here. */
  baseDim: number;
}

const COMFY_PROFILES: Record<Exclude<ComfyModelFamily, "unknown">, ComfyWorkflowProfile> = {
  // Guidance-distilled: 4 steps, cfg 1.0.
  "flux-schnell": { steps: 4, cfg: 1.0, samplerName: "euler", scheduler: "simple", baseDim: 1024 },
  // Dev variant needs real steps and a modest guidance.
  "flux-dev": { steps: 20, cfg: 3.5, samplerName: "euler", scheduler: "simple", baseDim: 1024 },
  "sdxl": { steps: 30, cfg: 7.0, samplerName: "dpmpp_2m", scheduler: "karras", baseDim: 1024 },
  "sd15": { steps: 25, cfg: 7.0, samplerName: "dpmpp_2m", scheduler: "karras", baseDim: 512 },
};

/**
 * Classify a checkpoint into a workflow family from its filename / model id.
 * Heuristic by design — there is no family field in the catalog — but it never
 * collides two distinct families: FLUX is detected before SDXL before SD1.5.
 */
export function classifyComfyFamily(...hints: Array<string | undefined>): ComfyModelFamily {
  const h = hints.filter(Boolean).join(" ").toLowerCase();
  if (h.includes("flux")) return h.includes("schnell") ? "flux-schnell" : "flux-dev";
  if (h.includes("sdxl") || h.includes("xl-base") || h.includes("-xl") || h.includes("_xl")) return "sdxl";
  if (/(sd[-_.]?1[._]?5|v1[-_.]?5|sd15|1[._]5[-_.]?pruned)/.test(h)) return "sd15";
  return "unknown";
}

/**
 * Map the shared aspect-ratio string to concrete pixel dimensions, scaled from
 * the family's native base resolution. Mirrors the embedded sd.cpp size table so
 * both local backends produce consistent shapes for the same request.
 */
export function comfySize(ratio: string | undefined, base: number): { width: number; height: number } {
  return localImageDimensions(ratio, base);
}

// ---------------------------------------------------------------------------
// ComfyUI txt2img workflow
// ---------------------------------------------------------------------------
// Node IDs are stable strings:
//   4  → CheckpointLoaderSimple (loads the model from checkpoint name)
//   6  → CLIPTextEncode (positive prompt)
//   7  → CLIPTextEncode (negative prompt — empty)
//   3  → KSampler (denoise + scheduler, per-family settings)
//   5  → EmptyLatentImage (aspect-ratio-derived dimensions)
//   8  → VAEDecode
//   9  → SaveImage (output)

interface ComfyWorkflow {
  [nodeId: string]: {
    class_type: string;
    inputs: Record<string, unknown>;
  };
}

function buildTxt2ImgWorkflow({
  checkpointName,
  prompt,
  seed,
  profile,
  width,
  height,
}: {
  checkpointName: string;
  prompt: string;
  seed?: number;
  profile: ComfyWorkflowProfile;
  width: number;
  height: number;
}): ComfyWorkflow {
  const resolvedSeed = seed ?? Math.floor(Math.random() * 2 ** 31);
  return {
    "4": {
      class_type: "CheckpointLoaderSimple",
      inputs: {
        ckpt_name: checkpointName,
      },
    },
    "6": {
      class_type: "CLIPTextEncode",
      inputs: {
        text: prompt,
        clip: ["4", 1],
      },
    },
    "7": {
      class_type: "CLIPTextEncode",
      inputs: {
        text: "",
        clip: ["4", 1],
      },
    },
    "3": {
      class_type: "KSampler",
      inputs: {
        seed: resolvedSeed,
        steps: profile.steps,
        cfg: profile.cfg,
        sampler_name: profile.samplerName,
        scheduler: profile.scheduler,
        denoise: 1.0,
        model: ["4", 0],
        positive: ["6", 0],
        negative: ["7", 0],
        latent_image: ["5", 0],
      },
    },
    "5": {
      class_type: "EmptyLatentImage",
      inputs: { width, height, batch_size: 1 },
    },
    "8": {
      class_type: "VAEDecode",
      inputs: { samples: ["3", 0], vae: ["4", 2] },
    },
    "9": {
      class_type: "SaveImage",
      inputs: { filename_prefix: "lunery_local", images: ["8", 0] },
    },
  };
}

// ---------------------------------------------------------------------------
// ComfyUI HTTP helpers
// ---------------------------------------------------------------------------

interface ComfyQueueResponse {
  prompt_id: string;
}

interface ComfyHistoryOutput {
  images?: Array<{ filename: string; subfolder: string; type: string }>;
}

interface ComfyHistoryEntry {
  status: { completed: boolean; status_str: string };
  outputs: Record<string, ComfyHistoryOutput>;
}

type ComfyHistoryResponse = Record<string, ComfyHistoryEntry>;

/**
 * Combine the caller's abort signal (user Stop) with a per-request timeout so a
 * single fetch aborts on whichever fires first.
 */
function requestSignal(timeoutMs: number, external?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return external ? AbortSignal.any([external, timeout]) : timeout;
}

const ABORT_ERROR = new ApiError({
  status: 499,
  code: "request_aborted",
  message: "Local image generation was cancelled.",
  retryable: false,
});

async function queueWorkflow(
  baseUrl: string,
  workflow: ComfyWorkflow,
  abortSignal?: AbortSignal,
): Promise<string> {
  if (abortSignal?.aborted) throw ABORT_ERROR;
  const response = await fetch(`${baseUrl}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: workflow }),
    signal: requestSignal(10_000, abortSignal),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new ApiError({
      status: 502,
      code: "provider_error",
      message: `ComfyUI queue failed (${response.status}): ${text.slice(0, 200)}`,
      retryable: true,
    });
  }
  const data = (await response.json()) as ComfyQueueResponse;
  if (!data.prompt_id) {
    throw new ApiError({
      status: 502,
      code: "provider_error",
      message: "ComfyUI returned no prompt_id",
      retryable: true,
    });
  }
  return data.prompt_id;
}

async function pollHistory(
  baseUrl: string,
  promptId: string,
  abortSignal?: AbortSignal,
  timeoutMs = 120_000,
): Promise<ComfyHistoryEntry> {
  const deadline = Date.now() + timeoutMs;
  let delayMs = 500;
  while (Date.now() < deadline) {
    if (abortSignal?.aborted) throw ABORT_ERROR;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (abortSignal?.aborted) throw ABORT_ERROR;
    const response = await fetch(`${baseUrl}/history/${promptId}`, {
      cache: "no-store",
      signal: requestSignal(5_000, abortSignal),
    });
    if (!response.ok) {
      delayMs = Math.min(delayMs * 1.5, 5000);
      continue;
    }
    delayMs = 500;
    const history = (await response.json()) as ComfyHistoryResponse;
    const entry = history[promptId];
    if (entry?.status?.completed) return entry;
    if (entry?.status?.status_str === "error") {
      throw new ApiError({
        status: 502,
        code: "provider_error",
        message: "ComfyUI reported a workflow execution error",
        retryable: true,
      });
    }
  }
  throw new ApiError({
    status: 504,
    code: "provider_timeout",
    message: "ComfyUI image generation timed out (2 min)",
    retryable: true,
  });
}

async function fetchOutputImage(
  baseUrl: string,
  entry: ComfyHistoryEntry,
  abortSignal?: AbortSignal,
): Promise<Buffer> {
  // Find the SaveImage node output (node "9" in our workflow).
  for (const output of Object.values(entry.outputs)) {
    const images = output.images ?? [];
    const first = images[0];
    if (first) {
      const params = new URLSearchParams({
        filename: first.filename,
        subfolder: first.subfolder,
        type: first.type,
      });
      const response = await fetch(`${baseUrl}/view?${params.toString()}`, {
        signal: requestSignal(30_000, abortSignal),
      });
      if (!response.ok) {
        throw new ApiError({
          status: 502,
          code: "provider_error",
          message: `ComfyUI image fetch failed (${response.status})`,
          retryable: true,
        });
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      return bytes;
    }
  }
  throw new ApiError({
    status: 502,
    code: "provider_error",
    message: "ComfyUI completed but returned no output images",
    retryable: true,
  });
}

/**
 * Cancel work on the ComfyUI server: delete the prompt if it is still queued and
 * interrupt it if it is currently executing. Best-effort — failures here must
 * not mask the original abort.
 */
async function cancelComfyJob(baseUrl: string, promptId: string): Promise<void> {
  await Promise.allSettled([
    fetch(`${baseUrl}/queue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ delete: [promptId] }),
      signal: AbortSignal.timeout(2_000),
    }),
    fetch(`${baseUrl}/interrupt`, {
      method: "POST",
      signal: AbortSignal.timeout(2_000),
    }),
  ]);
}

async function resolveComfyCheckpointName(modelId?: string): Promise<string> {
  const requested = modelId?.trim();
  if (!requested) {
    throw new ApiError({
      status: 400,
      code: "no_model_selected",
      message: "No local ComfyUI image model selected.",
      retryable: false,
    });
  }

  const imported = await findImportedModel(requested);
  if (imported?.capability === "image-gen" && imported.runtimeTarget === "comfyui" && imported.status === "ready") {
    return imported.fileName;
  }

  const catalogEntry = findHfModelEntry(requested);
  if (imported || catalogEntry) {
    throw new ApiError({
      status: 400,
      code: "incompatible_model",
      message: `The selected model is not a ready ComfyUI checkpoint: ${requested}`,
      retryable: false,
    });
  }

  throw new ApiError({
    status: 400,
    code: "invalid_model",
    message: `Unknown local ComfyUI image model: ${requested}`,
    retryable: false,
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate images via a local ComfyUI instance.
 *
 * Returns GenerateImageResult — same shape as other generation backends — so
 * the routing branch in image-generate.ts is type-transparent.
 *
 * Honors input.aspectRatio (per model family) and input.abortSignal (interrupts
 * the ComfyUI queue on Stop).
 *
 * Image edit (isEdit: true) is NOT handled locally in v1; callers must
 * route edit requests to the BYOK edit path (enforced in image-generate.ts).
 *
 * Live ComfyUI integration test pending — requires a running ComfyUI with a
 * compatible checkpoint.
 */
export async function generateImagesLocal(
  input: GenerateImageInput,
  endpoint = "http://127.0.0.1:8188",
): Promise<GenerateImageResult> {
  if (input.isEdit) {
    throw new ApiError({
      status: 400,
      code: "invalid_request",
      message: "Local image editing is not supported in v1. Use a BYOK image-edit provider for edits.",
      retryable: false,
    });
  }

  const images: Array<{ bytes: Buffer; mimeType: string }> = [];
  const warnings: string[] = [];
  const checkpointName = await resolveComfyCheckpointName(input.modelId);

  const family = classifyComfyFamily(checkpointName, input.modelId);
  if (family === "unknown") {
    throw new ApiError({
      status: 400,
      code: "incompatible_model",
      message: `The selected checkpoint family is not supported by Lunery's ComfyUI workflow: ${checkpointName}`,
      retryable: false,
    });
  }
  const profile = COMFY_PROFILES[family];
  const { width, height } = comfySize(input.aspectRatio, profile.baseDim);

  const abortSignal = input.abortSignal;
  // Track queued/running prompt ids so a Stop can cancel them on the server, not
  // just sever the local fetch.
  const activePromptIds = new Set<string>();
  const onAbort = () => {
    for (const id of activePromptIds) void cancelComfyJob(endpoint, id);
  };
  abortSignal?.addEventListener("abort", onAbort);

  const generateOne = async (index: number) => {
    let promptId: string | null = null;
    try {
      promptId = await queueWorkflow(
        endpoint,
        buildTxt2ImgWorkflow({ checkpointName, prompt: input.prompt, profile, width, height }),
        abortSignal,
      );
      activePromptIds.add(promptId);
      // Close the window where abort fires after the server queued the job but
      // before onAbort could see this id — cancel it on the server right away.
      if (abortSignal?.aborted) {
        void cancelComfyJob(endpoint, promptId);
        throw ABORT_ERROR;
      }
      const historyEntry = await pollHistory(endpoint, promptId, abortSignal);
      const bytes = await fetchOutputImage(endpoint, historyEntry, abortSignal);
      images.push({ bytes, mimeType: "image/png" });
    } catch (error) {
      warnings.push(
        `candidate_${index + 1}: ${error instanceof ApiError ? error.code : "generation_error"}`,
      );
    } finally {
      if (promptId) activePromptIds.delete(promptId);
    }
  };

  try {
    // Use allSettled so one failure doesn't abort the rest.
    await Promise.allSettled(
      Array.from({ length: input.count }, (_, i) => generateOne(i)),
    );
  } finally {
    abortSignal?.removeEventListener("abort", onAbort);
  }

  if (images.length === 0) {
    if (abortSignal?.aborted) throw ABORT_ERROR;
    throw new ApiError({
      status: 502,
      code: "provider_error",
      message: "Local ComfyUI image generation produced no images.",
      retryable: true,
    });
  }

  return {
    provider: "local-comfyui",
    model: input.modelId ?? checkpointName,
    endpoint,
    images,
    warnings,
  };
}
