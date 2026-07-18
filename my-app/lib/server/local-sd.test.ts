import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
  promises: {
    access: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockRejectedValue(new Error("not expected")),
    unlink: vi.fn().mockResolvedValue(undefined),
  },
}));

describe("local sd-cpp generation args", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("HOME", "/Users/tester");
    vi.stubEnv("LUNERY_DESKTOP_BRIDGE_URL", "http://127.0.0.1:49152");
    vi.stubEnv("LUNERY_DESKTOP_BRIDGE_TOKEN", "token");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ results: [{ ok: false, error: "intentional stop" }] }),
      }),
    );
  });

  it("runs FLUX.2 with the public decoder and LLM companion", async () => {
    const { generateImagesLocalSd } = await import("./local-sd");

    await expect(
      generateImagesLocalSd({
        runId: "run-flux-2",
        modelId: "flux2-dev-q4",
        prompt: "a product photo",
        count: 1,
        aspectRatio: "16:9",
      }),
    ).rejects.toThrow("Embedded sd.cpp produced no images");

    const fetchMock = vi.mocked(fetch);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      runId: string;
      runs: string[][];
      timeoutSecs: number;
    };
    const args = body.runs[0] ?? [];

    expect(args).toContain("--diffusion-model");
    expect(args).toContain("/Users/tester/.lunerylab/studio/models/sd-cpp/flux2-dev-Q4_K_M.gguf");
    expect(args).toContain("--vae");
    expect(args).toContain(
      "/Users/tester/.lunerylab/studio/models/sd-cpp/full_encoder_small_decoder.safetensors",
    );
    expect(args).toContain("--llm");
    expect(args).toContain(
      "/Users/tester/.lunerylab/studio/models/sd-cpp/Mistral-Small-3.2-24B-Instruct-2506-Q4_K_M.gguf",
    );
    expect(args).toContain("--diffusion-fa");
    expect(args).toContain("--offload-to-cpu");
    expect(args.slice(args.indexOf("-W"), args.indexOf("-W") + 2)).toEqual(["-W", "1408"]);
    expect(args.slice(args.indexOf("-H"), args.indexOf("-H") + 2)).toEqual(["-H", "792"]);
    expect(args).not.toContain("--clip_l");
    expect(args).not.toContain("--t5xxl");
    expect(body.runId).toBe("run-flux-2");
    expect(body.timeoutSecs).toBe(900);
  });

  it("surfaces a canceled native batch as request_aborted", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        results: [
          { ok: false, error: "sd canceled by client" },
          { ok: false, error: "sd canceled by client" },
        ],
      }),
    } as Response);
    const { generateImagesLocalSd } = await import("./local-sd");

    await expect(
      generateImagesLocalSd({
        runId: "run-canceled",
        modelId: "sdxl-base-1.0",
        prompt: "a product photo",
        count: 2,
      }),
    ).rejects.toMatchObject({ code: "request_aborted", status: 499 });
  });

  it("forwards AbortSignal cancellation with the matching runId", async () => {
    const fetchMock = vi.mocked(fetch);
    let acknowledgeCancel!: (response: Response) => void;
    const cancelAcknowledgement = new Promise<Response>((resolve) => {
      acknowledgeCancel = resolve;
    });
    fetchMock.mockImplementation((input, init) => {
      if (String(input).endsWith("/sd-cancel")) {
        return cancelAcknowledgement;
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("Aborted"), { name: "AbortError" })),
          { once: true },
        );
      });
    });
    const controller = new AbortController();
    const { generateImagesLocalSd } = await import("./local-sd");
    const generation = generateImagesLocalSd({
      runId: "run-abort",
      modelId: "sdxl-base-1.0",
      prompt: "a product photo",
      count: 1,
      abortSignal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/sd-generate"))).toBe(
        true,
      );
    });

    let settled = false;
    void generation.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    acknowledgeCancel({ ok: true, json: async () => ({ canceled: true }) } as Response);

    await expect(generation).rejects.toMatchObject({ code: "request_aborted" });
    const cancelCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith("/sd-cancel"));
    expect(JSON.parse(String(cancelCall?.[1]?.body))).toEqual({ runId: "run-abort" });
  });
});
