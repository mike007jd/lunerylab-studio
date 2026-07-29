import { describe, expect, it } from "vitest";
import { APP_VERSION } from "@/lib/app-version";
import packageJson from "@/package.json";

describe("APP_VERSION", () => {
  it("matches package.json version", () => {
    expect(APP_VERSION).toBe(packageJson.version);
  });
});
