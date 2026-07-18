/**
 * Local image generation via the embedded stable-diffusion.cpp `sd-cli` binary.
 *
 * Per-task spawn (NOT a resident server): one `sd-cli` process per candidate
 * image. The Rust desktop bridge (`POST /sd-generate`) runs the argv we build
 * here, timeout-bounded and killable, and reports per-run success. We pick the
 * temp output paths, so after a successful run we read the PNG bytes ourselves.
 *
 * Returns GenerateImageResult — identical to generateImagesLocal — so the
 * routing branch in image-generate.ts is
 * type-transparent. Image edit is NOT supported locally (parity with the
 * ComfyUI path); callers fall through to BYOK for edits.
 */

import "server-only";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ApiError } from "@/lib/server/errors";
import { findHfModelEntry } from "@/lib/hf-model-catalog";
import { findImportedModel, modelCachePath } from "@/lib/server/imported-model-registry";
import type { GenerateImageInput, GenerateImageResult } from "@/lib/server/generation-types";
import { localImageDimensions } from "@/lib/server/generation-dimensions";

/** Per-image wall-clock cap sent to the Rust executor (it clamps to [30,1800]). */
const PER_IMAGE_TIMEOUT_SECS = 300;
const FLUX2_PER_IMAGE_TIMEOUT_SECS = 900;
const FLUX1_COMPANIONS = {
  "ae.safetensors": modelCachePath("sd-cpp", "ae.safetensors"),
  "clip_l.safetensors": modelCachePath("sd-cpp", "clip_l.safetensors"),
  "t5xxl_fp16.safetensors": modelCachePath("sd-cpp", "t5xxl_fp16.safetensors"),
} as const;
const FLUX2_COMPANIONS = {
  "full_encoder_small_decoder.safetensors": modelCachePath("sd-cpp", "full_encoder_small_decoder.safetensors"),
  "Mistral-Small-3.2-24B-Instruct-2506-Q4_K_M.gguf": modelCachePath(
    "sd-cpp",
    "Mistral-Small-3.2-24B-Instruct-2506-Q4_K_M.gguf",
  ),
} as const;

function aspectToSize(ratio: string | undefined, base: number): { w: number; h: number } {
  const { width, height } = localImageDimensions(ratio, base);
  return { w: width, h: height };
}

function sizeFor(modelId: string, ratio: string | undefined): { w: number; h: number } {
  const base = modelId === "sd15-emaonly" ? 512 : 1024; // SDXL/FLUX native 1024
  return aspectToSize(ratio, base);
}

function timeoutForModel(modelId: string): number {
  return modelId === "flux2-dev-q4" ? FLUX2_PER_IMAGE_TIMEOUT_SECS : PER_IMAGE_TIMEOUT_SECS;
}

interface SdRunResult {
  ok: boolean;
  error: string | null;
}

const ABORT_ERROR = new ApiError({
  status: 499,
  code: "request_aborted",
  message: "Local image generation was cancelled.",
  retryable: false,
});

function isAbortError(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

async function buildArgs(opts: {
  modelId: string;
  prompt: string;
  outPath: string;
  seed: number;
  ratio: string | undefined;
}): Promise<{ args: string[] } | { error: string }> {
  const entry = findHfModelEntry(opts.modelId);
  const imported = entry ? undefined : await findImportedModel(opts.modelId);
  if (entry && (entry.capability !== "image-gen" || entry.runtimeTarget !== "sd-cpp")) {
    return { error: `Model ${opts.modelId} is not an sd-cpp image model` };
  }
  if (imported && (imported.capability !== "image-gen" || imported.runtimeTarget !== "sd-cpp")) {
    return { error: `Model ${opts.modelId} is not an sd-cpp image model` };
  }
  if (!entry && !imported) {
    return { error: `Model ${opts.modelId} is not an sd-cpp image model` };
  }
  const modelFile = imported?.modelPath ?? modelCachePath("sd-cpp", entry?.fileName || entry?.id || opts.modelId);
  const { w, h } = sizeFor(entry?.id ?? opts.modelId, opts.ratio);
  // TOCTOU avoidance: we used to `await fs.access(modelFile)` here, but the
  // file can vanish between the check and the sd-cli spawn. We let sd-cli
  // (running inside the Rust bridge `/sd-generate`) discover the missing file
  // itself; the bridge returns `r.error` strings that we translate below into
  // friendly messages — including the same "file not available" wording so
  // the UX is preserved.

  const common = (extra: string[]): string[] => [
    "-p", opts.prompt,
    "-W", String(w),
    "-H", String(h),
    "-s", String(opts.seed),
    "-o", opts.outPath,
    "-v",
    ...extra,
  ];

  if (opts.modelId === "flux1-schnell-q4") {
    // FLUX requires split companion files (VAE + CLIP-L + T5-XXL) alongside
    // the diffusion model; the pre-flight in generateImagesLocalSd guards them.
    return {
      args: [
        "--diffusion-model", modelFile,
        "--vae", FLUX1_COMPANIONS["ae.safetensors"],
        "--clip_l", FLUX1_COMPANIONS["clip_l.safetensors"],
        "--t5xxl", FLUX1_COMPANIONS["t5xxl_fp16.safetensors"],
        "--cfg-scale", "1.0",
        "--sampling-method", "euler",
        "--steps", "4",
        ...common([]),
      ],
    };
  }

  if (opts.modelId === "flux2-dev-q4") {
    return {
      args: [
        "--diffusion-model", modelFile,
        "--vae", FLUX2_COMPANIONS["full_encoder_small_decoder.safetensors"],
        "--llm", FLUX2_COMPANIONS["Mistral-Small-3.2-24B-Instruct-2506-Q4_K_M.gguf"],
        "--cfg-scale", "1.0",
        "--sampling-method", "euler",
        "--steps", "28",
        "--diffusion-fa",
        "--offload-to-cpu",
        ...common([]),
      ],
    };
  }

  const steps = opts.modelId === "sdxl-base-1.0" ? "30" : "20";
  const cfg = "7.0";
  return {
    args: ["-m", modelFile, "--cfg-scale", cfg, "--sampling-method", "euler", "--steps", steps, ...common([])],
  };
}

export async function generateImagesLocalSd(
  input: GenerateImageInput,
): Promise<GenerateImageResult> {
  if (input.isEdit) {
    throw new ApiError({
      status: 400,
      code: "invalid_request",
      message: "Local image editing is not supported. Use a BYOK image-edit provider for edits.",
      retryable: false,
    });
  }

  const bridgeUrl = process.env.LUNERY_DESKTOP_BRIDGE_URL;
  const bridgeToken = process.env.LUNERY_DESKTOP_BRIDGE_TOKEN;
  if (!bridgeUrl || !bridgeToken) {
    throw new ApiError({
      status: 503,
      code: "provider_error",
      message: "Desktop bridge unavailable for local image generation.",
      retryable: true,
    });
  }

  const modelId = input.modelId?.trim();
  if (!modelId) {
    throw new ApiError({
      status: 400,
      code: "no_model_selected",
      message: "No local image model selected.",
      retryable: false,
    });
  }
  const runId = input.runId?.trim() || randomUUID();

  // FLUX needs split companion files that are a
  // downloadable kit. Guard a partial/absent kit so the user gets an actionable
  // error naming the missing files instead of an opaque sd-cli stderr or a
  // silent cloud fallback (spec: "缺则返回可执行错误，不静默兜底").
  if (modelId === "flux1-schnell-q4" || modelId === "flux2-dev-q4") {
    const companions = modelId === "flux2-dev-q4" ? FLUX2_COMPANIONS : FLUX1_COMPANIONS;
    const missing: string[] = [];
    for (const [name, p] of Object.entries(companions)) {
      try {
        await fs.access(p);
      } catch {
        missing.push(name);
      }
    }
    if (missing.length > 0) {
      throw new ApiError({
        status: 400,
        code: "invalid_request",
        message:
          `${modelId === "flux2-dev-q4" ? "FLUX.2" : "FLUX.1"} needs companion files not yet on disk: ${missing.join(", ")}. ` +
          `Open Settings → Local models and download the full model kit ` +
          `— it fetches the diffusion model and required companion files together — or ` +
          `pick a single-file model (SDXL Base 1.0 / SD 1.5) for offline image generation.`,
        retryable: false,
      });
    }
  }

  const tmpBase = path.join(os.tmpdir(), `lunery-sd-${randomUUID()}`);
  const outPaths: string[] = [];
  const runs: string[][] = [];
  for (let i = 0; i < input.count; i += 1) {
    const outPath = `${tmpBase}-${i}.png`;
    const seed = Math.floor(Math.random() * 2 ** 31);
    const built = await buildArgs({ modelId, prompt: input.prompt, outPath, seed, ratio: input.aspectRatio });
    if ("error" in built) {
      throw new ApiError({ status: 400, code: "invalid_request", message: built.error, retryable: false });
    }
    outPaths.push(outPath);
    runs.push(built.args);
  }

  const images: Array<{ bytes: Buffer; mimeType: string }> = [];
  const warnings: string[] = [];
  let results: SdRunResult[] = [];
  // When the caller aborts (Agent Stop / request deadline), tell the bridge to
  // cancel the in-flight native batch — the AbortSignal alone only severs the
  // HTTP connection, it does NOT stop sd-cli, which would keep burning CPU/GPU.
  const abortSignal = input.abortSignal;
  let cancelRequest: Promise<void> | null = null;
  const cancelNativeRun = () => {
    cancelRequest ??= fetch(`${bridgeUrl}/sd-cancel`, {
      method: "POST",
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        "x-lunery-desktop-token": bridgeToken,
      },
      body: JSON.stringify({ runId }),
      signal: AbortSignal.timeout(15_000),
    }).then(async (response) => {
      if (!response.ok) {
        throw new Error(`Native cancellation failed with status ${response.status}.`);
      }
      const payload = (await response.json()) as { canceled?: unknown };
      if (payload.canceled !== true) {
        throw new Error("Native image generation did not stop.");
      }
    });
    return cancelRequest;
  };
  const waitForCancellation = () => cancelRequest ?? Promise.resolve();
  const onAbort = () => {
    void cancelNativeRun().catch(() => undefined);
  };
  if (abortSignal?.aborted) {
    onAbort();
    await waitForCancellation().catch(() => undefined);
    throw ABORT_ERROR;
  }
  abortSignal?.addEventListener("abort", onAbort, { once: true });
  try {
    try {
      const res = await fetch(`${bridgeUrl}/sd-generate`, {
        method: "POST",
        cache: "no-store",
        headers: { "content-type": "application/json", "x-lunery-desktop-token": bridgeToken },
        body: JSON.stringify({ runId, runs, timeoutSecs: timeoutForModel(modelId) }),
        signal: abortSignal,
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new ApiError({
          status: 502,
          code: "provider_error",
          message: `Embedded sd.cpp engine error (${res.status}): ${txt.slice(0, 300)}`,
          retryable: true,
        });
      }
      results = ((await res.json()) as { results: SdRunResult[] }).results;
      if (!Array.isArray(results) || results.length !== outPaths.length) {
        throw new ApiError({
          status: 502,
          code: "provider_error",
          message: "Embedded sd.cpp engine returned an invalid result count.",
          retryable: true,
        });
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (isAbortError(error, abortSignal)) throw ABORT_ERROR;
      throw new ApiError({
        status: 502,
        code: "provider_error",
        message: `Embedded sd.cpp engine unreachable: ${error instanceof Error ? error.message : "unknown"}`,
        retryable: true,
      });
    }

    if (results.some((result) => /\bcancel(?:ed|led)\b/i.test(result.error ?? ""))) {
      throw ABORT_ERROR;
    }

    for (let i = 0; i < outPaths.length; i += 1) {
      const r = results[i];
      if (r?.ok) {
        try {
          const bytes = await fs.readFile(outPaths[i]!); // safe: i < outPaths.length loop bound guarantees presence
          images.push({ bytes, mimeType: "image/png" });
        } catch {
          warnings.push(`candidate_${i + 1}: output_unreadable`);
        }
      } else {
        // Translate common errno strings the bridge surfaces (e.g. "No such
        // file or directory", "ENOENT") into actionable text so the user knows
        // they likely deleted the model file between Settings download and now.
        const raw = (r?.error ?? "generation_error").slice(0, 200);
        const friendly = /enoent|no such file/i.test(raw)
          ? "model_file_missing — open Settings → Local models to redownload"
          : raw;
        warnings.push(`candidate_${i + 1}: ${friendly}`);
      }
    }
  } finally {
    abortSignal?.removeEventListener("abort", onAbort);
    await waitForCancellation().catch(() => undefined);
    await Promise.all(outPaths.map((outPath) => fs.unlink(outPath).catch(() => undefined)));
  }

  if (images.length === 0) {
    throw new ApiError({
      status: 502,
      code: "provider_error",
      message: `Embedded sd.cpp produced no images. ${warnings.join("; ")}`.slice(0, 500),
      retryable: true,
    });
  }

  return {
    provider: "local-sd-cpp",
    model: modelId,
    images,
    warnings,
  };
}
