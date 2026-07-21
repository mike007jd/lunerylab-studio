import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "desktop-dist/**",
    "desktop-server/**",
    "src-tauri/target/**",
    "next-env.d.ts",
  ]),
  // No-default-model guardrail. The product policy (CLAUDE.md / AGENTS.md) is
  // that we never silently substitute a vendor model id for the user. The
  // only legitimate places to mention concrete model ids by literal are:
  //   - lib/byok-providers.ts                          (catalog + UI hints)
  //   - lib/server/byok-*.ts + lib/server/agent/**    (server-side dispatch)
  //   - lib/image-models.ts + lib/video-models.ts      (catalog entries)
  //   - scripts/**                                    (model-download tooling)
  // Anywhere else, a literal that matches a known vendor model id prefix is
  // almost certainly a forbidden fallback. This rule pins the policy so a
  // future hand-roll doesn't quietly reintroduce one.
  {
    files: [
      "components/**/*.ts",
      "components/**/*.tsx",
      "app/**/*.ts",
      "app/**/*.tsx",
      "lib/client/**/*.ts",
      "lib/client/**/*.tsx",
      "lib/presets/**/*.ts",
      "lib/i18n/**/*.ts",
      "lib/i18n/**/*.tsx",
      "lib/hooks/**/*.ts",
      "lib/utils/**/*.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "Literal[value=/^(dall-e|gpt-image|flux|veo|qwen|kling|wan|meshy|tripo)[-/:]/i]",
          message:
            "Hardcoded model id is forbidden outside the BYOK provider catalog + server dispatch. See CLAUDE.md → “NO DEFAULT MODEL”. The user must pick or connect a model; empty stays empty.",
        },
        {
          selector:
            "TemplateElement[value.cooked=/^(dall-e|gpt-image|flux|veo|qwen|kling|wan|meshy|tripo)[-/:]/i]",
          message:
            "Hardcoded model id (template literal) is forbidden outside the BYOK provider catalog + server dispatch. See CLAUDE.md → “NO DEFAULT MODEL”.",
        },
      ],
    },
  },
  // Client components must not import server-only AI SDK provider packages —
  // they would force the secret to leak into the client bundle. The provider
  // wiring lives in lib/server/* where the keychain bridge runs.
  {
    files: ["components/**/*.ts", "components/**/*.tsx", "lib/client/**/*.ts", "lib/client/**/*.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "@ai-sdk/openai", message: "Server-only — use via lib/server/byok-llm.ts." },
            { name: "@ai-sdk/anthropic", message: "Server-only — use via lib/server/byok-llm.ts." },
            { name: "@ai-sdk/google", message: "Server-only — use via lib/server/byok-llm.ts." },
            { name: "@ai-sdk/openai-compatible", message: "Server-only — use via lib/server/byok-llm.ts." },
            { name: "ai", message: "Server-only — use via lib/server/byok-llm.ts or generation helpers." },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
