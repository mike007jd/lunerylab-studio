import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";

let manifestCache = null;

async function sidecarManifest() {
  if (manifestCache) return manifestCache;
  const manifestPath = new URL("../sidecar-manifest.json", import.meta.url);
  manifestCache = JSON.parse(await readFile(manifestPath, "utf8"));
  return manifestCache;
}

export async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export async function verifySha256File(filePath, expectedSha256, label) {
  if (!/^[a-f0-9]{64}$/i.test(expectedSha256 ?? "")) {
    throw new Error(`${label} is missing a pinned SHA-256 digest.`);
  }
  const actual = await sha256File(filePath);
  if (actual !== expectedSha256.toLowerCase()) {
    throw new Error(`${label} SHA-256 mismatch: expected ${expectedSha256}, got ${actual}.`);
  }
}

export async function downloadFile(url, filePath, label) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`${label} download failed: HTTP ${response.status}`);
  }
  await pipeline(response.body, createWriteStream(filePath));
}

function githubApiHeaders() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  return {
    "user-agent": "lunerylab-build",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

export async function resolveGitHubReleaseAsset({ owner, repo, tag, assetName, assetPattern }) {
  const api = `https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`;
  const response = await fetch(api, { headers: githubApiHeaders() });
  if (!response.ok) {
    throw new Error(`GitHub release lookup failed for ${owner}/${repo}@${tag}: HTTP ${response.status}`);
  }
  const release = await response.json();
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const asset = assetName
    ? assets.find((item) => item.name === assetName)
    : assets.find((item) => assetPattern.test(item.name));
  if (!asset) {
    throw new Error(`Release asset not found for ${owner}/${repo}@${tag}.`);
  }
  const digest = typeof asset.digest === "string" ? asset.digest : "";
  if (!digest.startsWith("sha256:")) {
    throw new Error(`Release asset ${asset.name} has no GitHub sha256 digest; refusing unsigned download.`);
  }
  const manifest = await sidecarManifest();
  const pinned = manifest.assets.find((item) => item.name === asset.name);
  if (!pinned) {
    throw new Error(`Release asset ${asset.name} is not present in scripts/sidecar-manifest.json.`);
  }
  if (pinned.url !== asset.browser_download_url || Number(pinned.size) !== Number(asset.size ?? 0)) {
    throw new Error(`Release asset ${asset.name} does not match the pinned sidecar manifest.`);
  }
  if (pinned.sha256 !== digest.slice("sha256:".length).toLowerCase()) {
    throw new Error(`Release asset ${asset.name} digest changed from the pinned sidecar manifest.`);
  }
  return {
    name: asset.name,
    url: asset.browser_download_url,
    sha256: pinned.sha256,
    size: Number(asset.size ?? 0),
  };
}

export async function verifyNodeOfficialSha({ version, fileName, filePath }) {
  const sumsUrl = `https://nodejs.org/dist/${version}/SHASUMS256.txt`;
  const response = await fetch(sumsUrl, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Node SHASUMS lookup failed for ${version}: HTTP ${response.status}`);
  }
  const text = await response.text();
  const line = text
    .split(/\r?\n/)
    .find((entry) => entry.trim().endsWith(` ${fileName}`));
  const expected = line?.trim().split(/\s+/)[0];
  if (!expected) {
    throw new Error(`Node SHASUMS does not contain ${fileName}.`);
  }
  await verifySha256File(filePath, expected, `Node ${version} runtime`);
}
