import { describe, expect, it } from "vitest";
import { selectConfiguredModel3dProvider } from "@/lib/server/model3d-provider-selection";

const connection = {
  endpoint: "https://provider.example/v1",
  updatedAt: "2026-07-13T00:00:00.000Z",
};

describe("automatic 3D provider selection", () => {
  it("skips higher-priority metadata whose keychain secret is missing", () => {
    expect(
      selectConfiguredModel3dProvider(
        { meshy: connection, tripo: connection },
        new Set(["tripo"]),
      ),
    ).toBe("tripo");
  });

  it("returns no provider for metadata-only half states", () => {
    expect(selectConfiguredModel3dProvider({ meshy: connection }, new Set())).toBeNull();
  });
});
