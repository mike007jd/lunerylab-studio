import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  findImportedModel: vi.fn(),
  findHfModelEntry: vi.fn(),
}));

vi.mock("@/lib/server/imported-model-registry", () => ({
  findImportedModel: mocks.findImportedModel,
}));

vi.mock("@/lib/hf-model-catalog", () => ({
  findHfModelEntry: mocks.findHfModelEntry,
}));

import {
  classifyComfyFamily,
  comfySize,
  generateImagesLocal,
} from "@/lib/server/local-image";
import type { GenerateImageInput } from "@/lib/server/generation-types";

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("classifyComfyFamily", () => {
  it("classifies FLUX schnell vs dev, SDXL, SD1.5, and unknown", () => {
    expect(classifyComfyFamily("flux1-schnell-Q4_0.gguf")).toBe("flux-schnell");
    expect(classifyComfyFamily("flux2-dev-Q4_K_M.gguf")).toBe("flux-dev");
    expect(classifyComfyFamily("sd_xl_base_1.0.safetensors")).toBe("sdxl");
    expect(classifyComfyFamily("v1-5-pruned-emaonly.safetensors")).toBe("sd15");
    expect(classifyComfyFamily("mystery-checkpoint.safetensors")).toBe("unknown");
  });
});

describe("comfySize", () => {
  it("preserves requested ratios exactly near the family pixel budget", () => {
    expect(comfySize("1:1", 1024)).toEqual({ width: 1024, height: 1024 });
    expect(comfySize("16:9", 1024)).toEqual({ width: 1408, height: 792 });
    expect(comfySize("9:16", 512)).toEqual({ width: 360, height: 640 });
    expect(comfySize("4:3", 1024)).toEqual({ width: 1184, height: 888 });
    // Unknown ratio falls back to square.
    expect(comfySize("weird", 1024)).toEqual({ width: 1024, height: 1024 });
  });
});

function makeInput(overrides: Partial<GenerateImageInput> = {}): GenerateImageInput {
  return {
    prompt: "a cat",
    modelId: "sd_xl_base_1.0",
    count: 1,
    aspectRatio: "16:9",
    ...overrides,
  } as GenerateImageInput;
}

describe("generateImagesLocal", () => {
  it("uses the SDXL profile and aspect-ratio dimensions in the queued workflow", async () => {
    mocks.findImportedModel.mockResolvedValue({
      capability: "image-gen",
      fileName: "sd_xl_base_1.0.safetensors",
      runtimeTarget: "comfyui",
      status: "ready",
    });

    let queuedWorkflow: Record<string, { class_type: string; inputs: Record<string, unknown> }> | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/prompt")) {
          queuedWorkflow = JSON.parse(String(init?.body)).prompt;
          return Response.json({ prompt_id: "p1" });
        }
        if (url.includes("/history/")) {
          return Response.json({
            p1: {
              status: { completed: true, status_str: "success" },
              outputs: { "9": { images: [{ filename: "o.png", subfolder: "", type: "output" }] } },
            },
          });
        }
        if (url.includes("/view")) {
          return new Response(new Uint8Array([1, 2, 3]));
        }
        return new Response("nope", { status: 404 });
      }),
    );

    const result = await generateImagesLocal(makeInput({
      generationParameters: {
        seed: 4242,
        steps: 24,
        cfg: 5.5,
        negativePrompt: "blur, watermark",
      },
    }), "http://comfy");
    expect(result.provider).toBe("local-comfyui");
    expect(result.images).toHaveLength(1);

    const ws = queuedWorkflow!;
    expect(ws["3"]!.inputs).toMatchObject({ seed: 4242, steps: 24, cfg: 5.5, sampler_name: "dpmpp_2m", scheduler: "karras" });
    expect(ws["7"]!.inputs).toMatchObject({ text: "blur, watermark" });
    // 16:9 from SDXL base 1024.
    expect(ws["5"]!.inputs).toMatchObject({ width: 1408, height: 792 });
    expect(result.images[0]?.generationParameters).toEqual({
      seed: 4242,
      steps: 24,
      cfg: 5.5,
      negativePrompt: "blur, watermark",
      modelId: "sd_xl_base_1.0",
    });
  });

  it("cancels the ComfyUI job on abort and surfaces request_aborted", async () => {
    mocks.findImportedModel.mockResolvedValue({
      capability: "image-gen",
      fileName: "flux1-schnell.safetensors",
      runtimeTarget: "comfyui",
      status: "ready",
    });

    const controller = new AbortController();
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        seen.push(url);
        if (url.endsWith("/prompt")) {
          // Abort right after the job is queued.
          controller.abort();
          return Response.json({ prompt_id: "p1" });
        }
        if (url.endsWith("/queue") || url.endsWith("/interrupt")) {
          return Response.json({});
        }
        // history poll: signal is already aborted so pollHistory throws first.
        return new Response("nope", { status: 404 });
      }),
    );

    await expect(
      generateImagesLocal(makeInput({ modelId: "flux1-schnell", abortSignal: controller.signal }), "http://comfy"),
    ).rejects.toMatchObject({ code: "request_aborted" });

    expect(seen.some((u) => u.endsWith("/interrupt"))).toBe(true);
    expect(seen.some((u) => u.endsWith("/queue"))).toBe(true);
  });

  it("rejects an unknown checkpoint family before queueing", async () => {
    mocks.findImportedModel.mockResolvedValue({
      capability: "image-gen",
      fileName: "mystery-checkpoint.safetensors",
      runtimeTarget: "comfyui",
      status: "ready",
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(generateImagesLocal(makeInput({ modelId: "mystery" }), "http://comfy"))
      .rejects.toMatchObject({ code: "incompatible_model" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a checkpoint imported for another local image runtime", async () => {
    mocks.findImportedModel.mockResolvedValue({
      capability: "image-gen",
      fileName: "sd_xl_base_1.0.safetensors",
      runtimeTarget: "sd-cpp",
      status: "ready",
    });

    await expect(generateImagesLocal(makeInput(), "http://comfy"))
      .rejects.toMatchObject({ code: "incompatible_model" });
  });
});
