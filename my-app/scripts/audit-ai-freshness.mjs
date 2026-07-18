import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const root = process.cwd();
const metadataFiles = [
  "lib/hf-model-catalog.ts",
  "lib/byok-providers.ts",
  "lib/video-models.ts",
];

const stalePhraseFiles = [
  {
    file: "../README.md",
    patterns: [/Image models:/, /Video models:/],
  },
  {
    file: "README.md",
    patterns: [/SEEDANCE_BASE_URL/, /KELING_BASE_URL/, /Kling v2\.6/, /Veo 3\.1/],
  },
  {
    file: "lib/client/use-model-catalog.ts",
    patterns: [/defaultImageModelId:[\s\S]*imageModels\[0\]/, /return models\[0\]\?\.id/],
  },
  {
    file: "lib/image-models.ts",
    patterns: [/return models\[0\]\?\.id/],
  },
  {
    file: "../THIRD_PARTY_NOTICES.md",
    patterns: [/Open-source AI models we recommend/],
  },
  {
    file: "src-tauri/src/lib.rs",
    patterns: [/3×\+/, /outpaces sd-cpp Metal/],
    probeUrls: false,
  },
  {
    file: "lib/video-models.ts",
    patterns: [
      /Wan has no negative prompt/,
      /通义万相不支持负面 prompt/,
      /Kling supports negative prompts/,
      /可灵支持负面 prompt/,
    ],
  },
  {
    file: "lib/server/agent/v2/tools/generate-3d.ts",
    patterns: [/Preference order:/, /Meshy \/ Tripo \/ fal \/ Replicate/],
  },
  {
    file: "components/settings/local-models-panel.tsx",
    patterns: [
      /best default/,
      /Best first text model/,
      /首选文本模型/,
      /Search Qwen, SDXL, FLUX/,
      /搜索 Qwen、SDXL、FLUX/,
      /Search Qwen3\.6, Llama 4/,
      /搜索 Qwen3\.6、Llama 4/,
    ],
  },
  {
    file: "components/settings/desktop-runtime-card.tsx",
    patterns: [
      /modelIdHint:\s*"e\.g\. gpt-image/,
      /modelIdHint:\s*"示例：gpt-image/,
      /Unknown provider metadata[\s\S]*requiresModelId:\s*false/,
    ],
  },
  {
    file: "lib/i18n/messages/en.ts",
    patterns: [/Switch to GPT Image 1/],
  },
  {
    file: "lib/i18n/messages/zh-CN.ts",
    patterns: [/切换到 GPT Image 1/],
  },
  {
    file: "lib/i18n/messages/zh-TW.ts",
    patterns: [/切換到 GPT Image 1/],
  },
];

const currentCatalogForbiddenPatterns = [
  /qwen2\.5/i,
  /llama-3\.2/i,
  /Llama 3\.2/i,
  /flux1/i,
  /FLUX\.1/i,
  /sdxl/i,
  /SDXL/i,
  /sd15/i,
  /Stable Diffusion 1\.5/i,
  /Llama 4/i,
  /llama4/i,
];

const currentCatalogRequiredPatterns = [
  /Qwen3\.6/i,
  /DeepSeek V4/i,
  /FLUX\.2/i,
];

// Availability audit: each entry verifies the exact model id still EXISTS at
// its official source. Passing here means "this id is reachable/valid", NOT
// "this id is the current recommendation" — that stronger claim is covered by
// `recommendedCurrentModels` below for the few first-party providers where we
// actively track the recommended leaf model.
const exactSourceChecks = [
  {
    id: "gpt-image-2",
    url: "https://developers.openai.com/api/docs/models/gpt-image-2",
    strategy: "source-text",
  },
  {
    id: "claude-sonnet-4-6",
    url: "https://platform.claude.com/docs/en/about-claude/models/overview",
    strategy: "source-text",
  },
  {
    id: "gemini-3.1-pro-preview",
    url: "https://ai.google.dev/gemini-api/docs/gemini-3?hl=en",
    strategy: "source-text",
  },
  {
    id: "anthropic/claude-sonnet-4.6",
    url: "https://openrouter.ai/api/v1/models",
    strategy: "openrouter-models",
  },
  {
    id: "MiniMax-Hailuo-2.3",
    aliases: ["MiniMax Hailuo 2.3", "Hailuo 2.3"],
    url: "https://platform.minimax.io/docs/api-reference/video-generation-t2v",
    strategy: "source-text",
  },
  {
    id: "black-forest-labs/flux-2-pro",
    url: "https://replicate.com/black-forest-labs/flux-2-pro",
    strategy: "source-text",
  },
  {
    id: "fal-ai/flux-pro/v1.1",
    url: "https://fal.ai/models/fal-ai/flux-pro/v1.1/api",
    strategy: "source-text",
  },
  {
    id: "fal-ai/flux-pro/v1/fill",
    url: "https://fal.ai/models/fal-ai/flux-pro/v1/fill/api",
    strategy: "source-text",
  },
  {
    id: "fal-ai/birefnet",
    url: "https://fal.ai/models/fal-ai/birefnet/api",
    strategy: "source-text",
  },
  {
    id: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    url: "https://www.together.ai/models/llama-3-3-70b",
    strategy: "source-text",
  },
  {
    id: "accounts/fireworks/models/llama-v3p3-70b-instruct",
    aliases: ["llama-v3p3-70b-instruct"],
    url: "https://fireworks.ai/models/fireworks/llama-v3p3-70b-instruct",
    strategy: "source-text",
  },
  {
    id: "latest",
    url: "https://docs.meshy.ai/api/image-to-3d",
    strategy: "source-text",
  },
  {
    id: "v2.5-20250123",
    url: "https://github.com/VAST-AI-Research/tripo-python-sdk/blob/master/docs/API.md",
    strategy: "source-text",
  },
];

// Recommended-current audit: for the first-party providers we actively track,
// the BYOK placeholder must be the CURRENT recommended leaf model — not merely
// an available one (gpt-image-1.5 stays available but is no longer current).
// Re-verify against the provider's official page and bump `checkedAt` on change.
const recommendedCurrentModels = [
  {
    providerId: "openai",
    expected: "gpt-image-2",
    checkedAt: "2026-06-22",
    source: "https://developers.openai.com/api/docs/models/gpt-image-2",
  },
];

function extractProviderBlock(text, providerId) {
  const startMarker = `id: "${providerId}"`;
  const start = text.indexOf(startMarker);
  if (start < 0) return "";
  const next = text.indexOf('\n    id: "', start + startMarker.length);
  return text.slice(start, next < 0 ? text.length : next);
}

const today = process.env.AI_FRESHNESS_TODAY ?? new Date().toISOString().slice(0, 10);
const PROBE_ATTEMPTS = 3;
const PROBE_TIMEOUT_MS = 12_000;
const execFile = promisify(execFileCallback);

function compareDate(a, b) {
  return a.localeCompare(b);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function fetchWithTimeout(url, init = {}, timeoutMs = PROBE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function isHuggingFaceResolveArtifactUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "huggingface.co" && parsed.pathname.includes("/resolve/");
  } catch {
    return false;
  }
}

async function cancelBody(response) {
  if (response.body && typeof response.body.cancel === "function") {
    await response.body.cancel().catch(() => undefined);
  }
}

function shouldRetryStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function probeDetail(response, phase) {
  return `${phase} HTTP ${response.status}`;
}

async function probeUrlOnce(url) {
  if (!url || !/^https?:\/\//.test(url)) return { ok: true };
  const head = await fetchWithTimeout(url, {
    method: "HEAD",
    redirect: "follow",
  });
  if (head.ok || head.status === 405 || head.status === 403) {
    await cancelBody(head);
    return { ok: true };
  }
  await cancelBody(head);

  const get = await fetchWithTimeout(url, {
    method: "GET",
    redirect: "follow",
    headers: isHuggingFaceResolveArtifactUrl(url) ? { Range: "bytes=0-0" } : undefined,
  });
  const ok = get.ok || get.status === 403;
  const detail = probeDetail(get, "GET");
  await cancelBody(get);
  return { ok, detail };
}

async function probeUrlWithCurl(url) {
  const { stdout } = await execFile(
    "curl",
    [
      "-I",
      "-L",
      "--max-time",
      String(Math.ceil(PROBE_TIMEOUT_MS / 1000)),
      "-o",
      "/dev/null",
      "-w",
      "%{http_code}",
      url,
    ],
    { timeout: PROBE_TIMEOUT_MS + 2_000 },
  );
  const status = Number(stdout.trim());
  const ok = (status >= 200 && status < 300) || status === 403 || status === 405;
  return {
    ok,
    detail: Number.isFinite(status) && status > 0 ? `curl HEAD HTTP ${status}` : "curl HEAD failed",
  };
}

async function probeUrlResult(url) {
  if (!url || !/^https?:\/\//.test(url)) return { ok: true };
  let lastDetail = "not attempted";
  for (let attempt = 1; attempt <= PROBE_ATTEMPTS; attempt += 1) {
    try {
      const result = await probeUrlOnce(url);
      if (result.ok) return { ok: true };
      lastDetail = result.detail ?? "unreachable";
      if (!shouldRetryStatus(Number(lastDetail.match(/\d+$/)?.[0] ?? 0))) break;
    } catch (error) {
      lastDetail = error instanceof Error ? error.message : String(error);
    }
    if (attempt < PROBE_ATTEMPTS) {
      await sleep(500 * attempt);
    }
  }
  try {
    const result = await probeUrlWithCurl(url);
    if (result.ok) return { ok: true };
    lastDetail = result.detail ?? lastDetail;
  } catch (error) {
    lastDetail = error instanceof Error ? error.message : String(error);
  }
  return { ok: false, detail: lastDetail };
}

function probeFailureSuffix(result) {
  return result.detail ? ` (${result.detail})` : "";
}

async function head(url, redirect = "follow") {
  let lastError = null;
  let lastResponse = null;
  for (let attempt = 1; attempt <= PROBE_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, { method: "HEAD", redirect });
      lastResponse = response;
      if (!shouldRetryStatus(response.status) || attempt === PROBE_ATTEMPTS) {
        return response;
      }
    } catch (error) {
      lastError = error;
    }
    if (attempt < PROBE_ATTEMPTS) {
      await sleep(500 * attempt);
    }
  }
  if (lastResponse) return lastResponse;
  throw lastError ?? new Error("HEAD request failed");
}

const failures = [];
const seenUrls = new Set();
const textCache = new Map();
let openRouterModels = null;

function absoluteFor(file) {
  return file.startsWith("../") ? path.join(root, file) : path.join(root, file);
}

function extractUrls(text) {
  return [...text.matchAll(/https?:\/\/[^\s"',)<>\]]+/g)].map((m) => m[0]);
}

function isProbeableSourceUrl(url) {
  if (url.includes("${") || url.includes("...")) return false;
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname !== "localhost" &&
      parsed.hostname !== "127.0.0.1" &&
      parsed.hostname !== "::1" &&
      !parsed.hostname.endsWith(".example")
    );
  } catch {
    return false;
  }
}

function extractMetadataSourceUrls(text) {
  return [
    ...[...text.matchAll(/url:\s*"([^"]+)"/g)].map((m) => m[1]),
    ...[...text.matchAll(/evidence\("[^"]+",\s*"([^"]+)"/g)].map((m) => m[1]),
  ];
}

function normalizeForSearch(value) {
  return value.toLowerCase();
}

async function fetchText(url) {
  const cached = textCache.get(url);
  if (cached !== undefined) return cached;
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await response.text();
  textCache.set(url, text);
  return text;
}

function sourceTextContains(text, id, aliases = []) {
  const haystack = normalizeForSearch(text);
  const candidates = [id, ...aliases].flatMap((candidate) => [
    candidate,
    encodeURIComponent(candidate),
    candidate.replaceAll("/", "\\/"),
  ]);
  return candidates.some((candidate) => haystack.includes(normalizeForSearch(candidate)));
}

async function assertSourceTextContains({ id, aliases = [], url }) {
  try {
    const text = await fetchText(url);
    if (!sourceTextContains(text, id, aliases)) {
      failures.push(`exact model check failed: ${id} not found in ${url}`);
    }
  } catch (error) {
    failures.push(`exact model check failed: ${id} source unreadable ${url}: ${error.message}`);
  }
}

async function assertOpenRouterModel(id, url) {
  try {
    if (!openRouterModels) {
      const response = await fetch(url, { redirect: "follow" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      openRouterModels = new Set((payload.data ?? []).map((model) => model.id));
    }
    if (!openRouterModels.has(id)) failures.push(`OpenRouter model id missing from live catalog: ${id}`);
  } catch (error) {
    failures.push(`OpenRouter exact model check failed for ${id}: ${error.message}`);
  }
}

function extractArrayBlock(text, exportName) {
  const start = text.indexOf(`export const ${exportName} = [`);
  if (start < 0) return "";
  const endMarker = "] as const satisfies HfModelEntry[];";
  const end = text.indexOf(endMarker, start);
  if (end < 0) return "";
  return text.slice(start, end + endMarker.length);
}

function readQuotedValue(line, lines, index) {
  const inline = line.match(/"([^"]+)"/);
  if (inline) return inline[1];
  const next = lines[index + 1]?.match(/"([^"]+)"/);
  return next?.[1] ?? "";
}

function hfRepoFromResolveUrl(downloadUrl) {
  const match = downloadUrl.match(/^https:\/\/huggingface\.co\/([^/]+\/[^/]+)\/resolve\//);
  return match?.[1] ?? "";
}

function extractHfEntries(text) {
  const entries = [];
  const lines = text.split(/\r?\n/);
  let entry = null;
  let companion = null;
  let companionIndex = 0;

  function pushCompanion() {
    if (!entry || !companion?.downloadUrl) return;
    entries.push({
      ...companion,
      id: `${entry.id}:${companion.fileName || `companion-${companionIndex}`}`,
      hfRepo: hfRepoFromResolveUrl(companion.downloadUrl),
    });
    companion = null;
    companionIndex += 1;
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const idMatch = line.match(/^\s+id:\s*"([^"]+)"/);
    if (idMatch) {
      pushCompanion();
      if (entry?.id) entries.push(entry);
      entry = { id: idMatch[1], hfRepo: "", fileName: "", sha256: null, downloadUrl: "" };
      companionIndex = 0;
      continue;
    }
    if (!entry) continue;

    if (/^\s+companions:/.test(line)) {
      companion = null;
      continue;
    }
    if (/^\s+\{\s*$/.test(line) && entry.downloadUrl) {
      companion = { fileName: "", sha256: null, downloadUrl: "" };
      continue;
    }
    if (companion && /^\s+\},?/.test(line)) {
      pushCompanion();
      continue;
    }
    if (companion) {
      if (!companion.fileName && /^\s+fileName:/.test(line)) {
        companion.fileName = readQuotedValue(line, lines, i);
        continue;
      }
      if (companion.sha256 === null && /^\s+sha256:/.test(line)) {
        companion.sha256 = line.includes("null") ? null : readQuotedValue(line, lines, i);
        continue;
      }
      if (!companion.downloadUrl && /^\s+downloadUrl:/.test(line)) {
        companion.downloadUrl = readQuotedValue(line, lines, i);
        continue;
      }
    }

    if (!entry.hfRepo && /^\s+hfRepo:/.test(line)) {
      entry.hfRepo = readQuotedValue(line, lines, i);
      continue;
    }
    if (!entry.fileName && /^\s+fileName:/.test(line)) {
      entry.fileName = readQuotedValue(line, lines, i);
      continue;
    }
    if (entry.sha256 === null && /^\s+sha256:/.test(line)) {
      entry.sha256 = line.includes("null") ? null : readQuotedValue(line, lines, i);
      continue;
    }
    if (!entry.downloadUrl && /^\s+downloadUrl:/.test(line)) {
      entry.downloadUrl = readQuotedValue(line, lines, i);
    }
  }

  pushCompanion();
  if (entry?.id) entries.push(entry);
  return entries.filter((item) => item.hfRepo && item.downloadUrl);
}

async function assertHuggingFaceArtifact(entry) {
  const repoUrl = `https://huggingface.co/${entry.hfRepo}`;
  const repoProbe = await probeUrlResult(repoUrl);
  if (!repoProbe.ok) {
    failures.push(
      `Hugging Face repo unreachable for ${entry.id}: ${repoUrl}${probeFailureSuffix(repoProbe)}`
    );
  }
  const artifactProbe = await probeUrlResult(entry.downloadUrl);
  if (!artifactProbe.ok) {
    failures.push(
      `Hugging Face artifact unreachable for ${entry.id}: ${entry.downloadUrl}${probeFailureSuffix(artifactProbe)}`
    );
    return;
  }
  if (!entry.sha256 || !entry.downloadUrl.includes("/resolve/")) return;

  try {
    const response = await head(entry.downloadUrl, "manual");
    const linkedEtag = response.headers.get("x-linked-etag")?.replaceAll("\"", "");
    if (!linkedEtag) {
      failures.push(
        `Hugging Face artifact hash missing for ${entry.id}: ${entry.downloadUrl} (HEAD HTTP ${response.status})`
      );
      return;
    }
    if (linkedEtag.toLowerCase() !== entry.sha256.toLowerCase()) {
      failures.push(`Hugging Face artifact hash mismatch for ${entry.id}: expected ${entry.sha256}, got ${linkedEtag}`);
    }
  } catch (error) {
    failures.push(`Hugging Face artifact hash check failed for ${entry.id}: ${error.message}`);
  }
}

function extractProviderExactIds(text) {
  return [
    ...[...text.matchAll(/placeholderModelId:\s*"([^"]+)"/g)].map((m) => m[1]),
    ...[...text.matchAll(/\b(?:inpaint|backgroundRemove|controlnet):\s*"([^"]+)"/g)].map((m) => m[1]),
    ...[...text.matchAll(/\b(?:aiModel|modelVersion):\s*"([^"]+)"/g)].map((m) => m[1]),
  ].filter((id) => id !== "local-model-id");
}

for (const file of metadataFiles) {
  const absolute = path.join(root, file);
  const text = await readFile(absolute, "utf8");

  const expires = [
    ...[...text.matchAll(/freshnessExpiresAt:\s*"(\d{4}-\d{2}-\d{2})"/g)].map((m) => m[1]),
    ...[...text.matchAll(/[A-Z_]*FRESHNESS_EXPIRES_AT\s*=\s*"(\d{4}-\d{2}-\d{2})"/g)].map((m) => m[1]),
  ];
  const verified = [
    ...text.matchAll(/lastVerifiedAt:\s*(?:[A-Z_]*FRESHNESS_BASELINE|"(\d{4}-\d{2}-\d{2})")/g),
  ];
  const urls = extractMetadataSourceUrls(text);

  if (expires.length === 0) failures.push(`${file}: no freshnessExpiresAt fields found`);
  if (verified.length === 0) failures.push(`${file}: no lastVerifiedAt fields found`);

  for (const date of expires) {
    if (compareDate(date, today) < 0) failures.push(`${file}: freshnessExpiresAt ${date} is before ${today}`);
  }

  for (const url of urls) {
    if (!isProbeableSourceUrl(url) || seenUrls.has(url)) continue;
    seenUrls.add(url);
    const result = await probeUrlResult(url);
    if (!result.ok) {
      failures.push(`${file}: source URL unreachable: ${url}${probeFailureSuffix(result)}`);
    }
  }
}

{
  const text = await readFile(path.join(root, "lib/hf-model-catalog.ts"), "utf8");
  const currentCatalog = extractArrayBlock(text, "HF_MODEL_CATALOG");
  if (!currentCatalog) {
    failures.push("lib/hf-model-catalog.ts: could not find HF_MODEL_CATALOG block");
  } else {
    for (const pattern of currentCatalogForbiddenPatterns) {
      if (pattern.test(currentCatalog)) {
        failures.push(`lib/hf-model-catalog.ts: old model still present in HF_MODEL_CATALOG: ${pattern}`);
      }
    }
    for (const pattern of currentCatalogRequiredPatterns) {
      if (!pattern.test(currentCatalog)) {
        failures.push(`lib/hf-model-catalog.ts: current catalog missing required current model family: ${pattern}`);
      }
    }
  }

  for (const entry of extractHfEntries(text)) {
    await assertHuggingFaceArtifact(entry);
  }
}

{
  const text = await readFile(path.join(root, "lib/byok-providers.ts"), "utf8");
  const exactCheckIds = new Set(exactSourceChecks.map((check) => check.id));
  for (const id of extractProviderExactIds(text)) {
    if (!exactCheckIds.has(id)) failures.push(`BYOK exact model id has no audit check: ${id}`);
  }
  // Recommended-current: placeholder must equal the tracked current leaf model.
  for (const rec of recommendedCurrentModels) {
    const block = extractProviderBlock(text, rec.providerId);
    const actual = block.match(/placeholderModelId:\s*"([^"]+)"/)?.[1];
    if (actual !== rec.expected) {
      failures.push(
        `recommended-current check: ${rec.providerId} placeholder is "${actual ?? "(none)"}", expected current "${rec.expected}" (verified ${rec.checkedAt}, ${rec.source})`,
      );
    }
  }
}

for (const check of exactSourceChecks) {
  if (isProbeableSourceUrl(check.url) && !seenUrls.has(check.url)) seenUrls.add(check.url);
  if (check.strategy === "openrouter-models") {
    await assertOpenRouterModel(check.id, check.url);
  } else {
    await assertSourceTextContains(check);
  }
}

for (const { file, patterns, probeUrls = true } of stalePhraseFiles) {
  const absolute = absoluteFor(file);
  const text = await readFile(absolute, "utf8");
  for (const pattern of patterns) {
    if (pattern.test(text)) failures.push(`${file}: stale phrase still present: ${pattern}`);
  }
  if (!probeUrls) continue;
  for (const url of extractUrls(text)) {
    if (!isProbeableSourceUrl(url) || seenUrls.has(url)) continue;
    seenUrls.add(url);
    const result = await probeUrlResult(url);
    if (!result.ok) {
      failures.push(`${file}: source URL unreachable: ${url}${probeFailureSuffix(result)}`);
    }
  }
}

if (failures.length > 0) {
  console.error(`AI freshness audit failed (${today}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`AI freshness audit passed (${today}); checked ${seenUrls.size} source URLs.`);
