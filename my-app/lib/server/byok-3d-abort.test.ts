import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  downloadRemoteBytes: vi.fn(),
  resolveByokProviderConfig: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/server/byok-shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/byok-shared")>()),
  downloadRemoteBytes: mocks.downloadRemoteBytes,
}));

vi.mock("@/lib/server/byok-provider-config", () => ({
  resolveByokProviderConfig: mocks.resolveByokProviderConfig,
}));

import { generateModel3dByok } from "@/lib/server/byok-3d";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveByokProviderConfig.mockResolvedValue({
    providerId: "meshy",
    providerMeta: {
      label: "Meshy",
      modelApiMode: "meshy",
      fixedModel3dOperation: "image-to-3d",
      model3dDefaultParams: {},
    },
    apiKey: "key",
    endpoint: "https://api.meshy.example",
    modelId: "image-to-3d",
  });
  mocks.downloadRemoteBytes.mockResolvedValue({
    bytes: Buffer.from("glb"),
    mimeType: "model/gltf-binary",
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("generateModel3dByok cancellation", () => {
  it("threads the caller signal through Meshy create, poll, and download", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: "task-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "SUCCEEDED",
            model_urls: { glb: "https://cdn.meshy.example/model.glb" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await generateModel3dByok(
      { referenceImage: Buffer.from("png"), abortSignal: controller.signal },
      "meshy",
    );

    const createSignal = fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal;
    const pollSignal = fetchMock.mock.calls[1]?.[1]?.signal as AbortSignal;
    expect(createSignal.aborted).toBe(false);
    expect(pollSignal.aborted).toBe(false);
    expect(mocks.downloadRemoteBytes).toHaveBeenCalledWith(
      "https://cdn.meshy.example/model.glb",
      expect.objectContaining({ abortSignal: controller.signal }),
    );

    controller.abort();
    expect(createSignal.aborted).toBe(true);
    expect(pollSignal.aborted).toBe(true);
  });
});
