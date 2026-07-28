import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(appRoot, "..");
const ignoredDirs = new Set([
  ".git",
  ".next",
  "desktop-dist",
  "desktop-server",
  "engine",
  "node_modules",
  "target",
]);
const lengthExempt = new Set(["THIRD_PARTY_NOTICES.md"]);
const maxLines = 180;
const maxWords = 1000;
const nonEnglishScripts =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const markdownLink = /!?\[[^\]]*]\(([^)]+)\)/g;
const contextImport = /^@(.+\.md)$/gm;

function walk(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirs.has(entry.name)) continue;
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      walk(path, files);
    } else if (extname(entry.name).toLowerCase() === ".md") {
      files.push(path);
    }
  }
  return files;
}

function display(path) {
  return relative(repoRoot, path);
}

function linkTarget(raw) {
  const trimmed = raw.trim();
  const target = trimmed.startsWith("<")
    ? trimmed.slice(1, trimmed.indexOf(">"))
    : trimmed.split(/\s+["']/)[0];
  return target.split("#")[0].split("?")[0];
}

const failures = [];
const files = walk(repoRoot).sort();

for (const file of files) {
  const text = readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;

  lines.forEach((line, index) => {
    if (nonEnglishScripts.test(line)) {
      failures.push(`${display(file)}:${index + 1}: non-English CJK text`);
    }
  });

  if (
    !lengthExempt.has(display(file)) &&
    (lines.length > maxLines || words > maxWords)
  ) {
    failures.push(
      `${display(file)}: text-heavy (${lines.length} lines, ${words} words; max ${maxLines}/${maxWords})`,
    );
  }

  for (const match of text.matchAll(markdownLink)) {
    const target = linkTarget(match[1]);
    if (
      !target ||
      target.startsWith("#") ||
      /^[a-z][a-z0-9+.-]*:/i.test(target)
    ) {
      continue;
    }

    let decoded;
    try {
      decoded = decodeURIComponent(target);
    } catch {
      failures.push(`${display(file)}: invalid encoded link ${target}`);
      continue;
    }

    const resolved = decoded.startsWith("/")
      ? resolve(repoRoot, decoded.slice(1))
      : resolve(dirname(file), decoded);
    if (!existsSync(resolved)) {
      failures.push(`${display(file)}: missing local link ${target}`);
      continue;
    }
  }

  for (const match of text.matchAll(contextImport)) {
    const target = match[1].trim();
    const resolved = resolve(dirname(file), target);
    if (!existsSync(resolved)) {
      failures.push(`${display(file)}: missing agent import ${target}`);
    }
  }
}

if (failures.length > 0) {
  console.error("Documentation checks failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `Documentation checks passed: ${files.length} Markdown files; English, links, imports, and density.`,
);
