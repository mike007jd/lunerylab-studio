import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": new URL("./", import.meta.url).pathname,
    },
  },
  test: {
    // Component tests opt into happy-dom via a per-file `@vitest-environment` docblock.
    environment: "node",
    include: [
      "lib/**/*.test.ts",
      "lib/**/*.test.tsx",
      "components/**/*.test.ts",
      "components/**/*.test.tsx",
    ],
  },
});
