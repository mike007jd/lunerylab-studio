import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const appRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(appRoot, "..");
const licenseDir = resolve(appRoot, "engine", "licenses");
const manifest = JSON.parse(readFileSync(resolve(appRoot, "scripts", "sidecar-manifest.json"), "utf8"));
const notices = readFileSync(resolve(repoRoot, "THIRD_PARTY_NOTICES.md"), "utf8");

const licenses = new Map([
  ["ggml-org/llama.cpp", "llama.cpp-LICENSE"],
  ["leejet/stable-diffusion.cpp", "stable-diffusion.cpp-LICENSE"],
  ["SharpAI/SwiftLM", "SwiftLM-LICENSE"],
]);

for (const file of licenses.values()) {
  const path = resolve(licenseDir, file);
  if (!existsSync(path) || statSync(path).size === 0) {
    throw new Error(`Missing or empty bundled engine license: engine/licenses/${file}`);
  }
}

const bundledSection = notices.match(/## Bundled engine sidecars\n([\s\S]*?)(?=\n## )/)?.[1];
if (!bundledSection) throw new Error("THIRD_PARTY_NOTICES.md has no bundled engine sidecar section.");

const noticeRepos = new Set(
  [...bundledSection.matchAll(/https:\/\/github\.com\/([^/)]+\/[^/)]+)/g)].map((match) => match[1]),
);
const manifestRepos = new Set(
  manifest.assets.map((asset) => {
    const [, owner, repo] = new URL(asset.url).pathname.split("/");
    return `${owner}/${repo}`;
  }),
);

const unexpected = [...noticeRepos].filter((repo) => !manifestRepos.has(repo));
const missing = [...manifestRepos].filter((repo) => !noticeRepos.has(repo));
const unlicensed = [...manifestRepos].filter((repo) => !licenses.has(repo));
if (unexpected.length || missing.length || unlicensed.length) {
  throw new Error(
    `Bundled component mismatch: unexpected=${unexpected.join(",") || "none"}; ` +
      `missing=${missing.join(",") || "none"}; unlicensed=${unlicensed.join(",") || "none"}`,
  );
}

console.log(`[verify-third-party-licenses] OK: ${licenses.size} licenses; ${manifestRepos.size} sidecar components`);
