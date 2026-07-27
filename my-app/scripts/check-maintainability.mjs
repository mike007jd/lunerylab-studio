#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const CONFIG_FILE = "maintainability.config.json";
const ALWAYS_SKIPPED_DIRS = new Set([
  ".git",
  ".next",
  ".turbo",
  "coverage",
  "desktop-dist",
  "desktop-server",
  "dist",
  "node_modules",
  "out",
  "playwright-report",
  "target",
  "test-results",
]);

function normalizePath(value) {
  return value.split(path.sep).join("/");
}

function countLines(source) {
  const normalized = source.replace(/\r\n/g, "\n");
  if (normalized.length === 0) return 0;
  const withoutTerminalNewline = normalized.endsWith("\n")
    ? normalized.slice(0, -1)
    : normalized;
  return withoutTerminalNewline.length === 0
    ? 0
    : withoutTerminalNewline.split("\n").length;
}

function globToRegExp(glob) {
  let pattern = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === "*") {
      if (glob[index + 1] === "*") {
        const followedBySlash = glob[index + 2] === "/";
        pattern += followedBySlash ? "(?:.*/)?" : ".*";
        index += followedBySlash ? 2 : 1;
      } else {
        pattern += "[^/]*";
      }
      continue;
    }
    if (character === "?") {
      pattern += "[^/]";
      continue;
    }
    if (/[\^$+.\-()|{}\[\]\\]/.test(character)) {
      pattern += `\\${character}`;
    } else {
      pattern += character;
    }
  }
  pattern += "$";
  return new RegExp(pattern);
}

function classifyFile(relativePath) {
  const basename = path.posix.basename(relativePath);
  if (
    /(?:^|\.)(?:test|spec)\.[^.]+$/.test(basename) ||
    relativePath.startsWith("e2e/") ||
    relativePath.includes("/e2e/")
  ) {
    return "test";
  }
  if (relativePath.startsWith("scripts/")) return "script";
  if (relativePath.endsWith(".rs")) return "rust";
  if (/(?:^|\/)route\.(?:ts|tsx|js|jsx)$/.test(relativePath)) return "route";
  if (
    relativePath.startsWith("hooks/") ||
    /(?:^|\/)use[A-Z][^/]*\.(?:ts|tsx)$/.test(relativePath)
  ) {
    return "hook";
  }
  if (relativePath.endsWith(".tsx")) return "react";
  return "source";
}

function walk(root, directory, extensions, files = []) {
  if (!fs.existsSync(directory)) return files;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ALWAYS_SKIPPED_DIRS.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(root, absolute, extensions, files);
      continue;
    }
    if (!extensions.has(path.extname(entry.name))) continue;
    files.push(normalizePath(path.relative(root, absolute)));
  }
  return files;
}

function loadConfig(root) {
  const configPath = path.join(root, CONFIG_FILE);
  if (!fs.existsSync(configPath)) {
    throw new Error(`Missing ${CONFIG_FILE} in ${root}`);
  }
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  for (const key of ["roots", "extensions", "limits"]) {
    if (!config[key]) throw new Error(`${CONFIG_FILE} is missing "${key}"`);
  }
  return config;
}

function readArgValue(name) {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function runGit(cwd, args, { quiet = false } = {}) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: quiet ? ["ignore", "pipe", "ignore"] : ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

function resolveGitContext(root) {
  const gitRoot = runGit(root, ["rev-parse", "--show-toplevel"], { quiet: true });
  if (!gitRoot) return { gitRoot: null, projectPrefix: "", baseRef: null };

  const explicitBase = readArgValue("--base") || process.env.MAINTAINABILITY_BASE_REF || null;
  const baseRef = explicitBase || runGit(root, ["rev-parse", "--verify", "HEAD^"], { quiet: true });
  const projectPrefix = normalizePath(path.relative(gitRoot, root));
  return {
    gitRoot,
    projectPrefix: projectPrefix === "." ? "" : projectPrefix,
    baseRef,
  };
}

function readBaseSource(gitContext, relativePath) {
  if (!gitContext.gitRoot || !gitContext.baseRef) return null;
  const gitPath = gitContext.projectPrefix
    ? `${gitContext.projectPrefix}/${relativePath}`
    : relativePath;
  try {
    return execFileSync("git", ["show", `${gitContext.baseRef}:${gitPath}`], {
      cwd: gitContext.gitRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

function evaluateFile({ lines, target, ceiling, baseLines, hotspot }) {
  if (hotspot) {
    if (lines > ceiling) return "fail";
    return lines > target ? "ratchet" : "pass";
  }
  if (lines <= target) return "pass";
  if (baseLines == null) return "new-oversized";
  if (lines > baseLines) return "fail";
  return "grandfathered";
}

function runSelfTest() {
  assert.equal(countLines(""), 0);
  assert.equal(countLines("one"), 1);
  assert.equal(countLines("one\ntwo\n"), 2);
  assert.equal(countLines("one\r\ntwo\r\n"), 2);

  assert.equal(globToRegExp("**/*.test.ts").test("a.test.ts"), true);
  assert.equal(globToRegExp("**/*.test.ts").test("lib/a.test.ts"), true);
  assert.equal(globToRegExp("components/ui/**").test("components/ui/button.tsx"), true);
  assert.equal(globToRegExp("scripts/*.mjs").test("scripts/check.mjs"), true);
  assert.equal(globToRegExp("scripts/*.mjs").test("scripts/nested/check.mjs"), false);

  assert.equal(classifyFile("app/api/items/route.ts"), "route");
  assert.equal(classifyFile("hooks/useThing.ts"), "hook");
  assert.equal(classifyFile("components/Thing.tsx"), "react");
  assert.equal(classifyFile("src-tauri/src/lib.rs"), "rust");
  assert.equal(classifyFile("lib/thing.test.ts"), "test");
  assert.equal(classifyFile("e2e/boot.ts"), "test");

  assert.equal(evaluateFile({ lines: 700, target: 400, ceiling: 700, baseLines: 700, hotspot: true }), "ratchet");
  assert.equal(evaluateFile({ lines: 701, target: 400, ceiling: 700, baseLines: 700, hotspot: true }), "fail");
  assert.equal(evaluateFile({ lines: 650, target: 500, ceiling: 500, baseLines: 650, hotspot: false }), "grandfathered");
  assert.equal(evaluateFile({ lines: 651, target: 500, ceiling: 500, baseLines: 650, hotspot: false }), "fail");
  assert.equal(evaluateFile({ lines: 501, target: 500, ceiling: 500, baseLines: null, hotspot: false }), "new-oversized");

  console.log("PASS maintainability checker self-test");
}

function audit(root, config, gitContext) {
  const extensions = new Set(config.extensions);
  const ignorePatterns = (config.ignore ?? []).map(globToRegExp);
  const hotspots = config.hotspots ?? {};
  const discovered = new Set();

  for (const configuredRoot of config.roots) {
    const absoluteRoot = path.join(root, configuredRoot);
    for (const relativePath of walk(root, absoluteRoot, extensions)) {
      discovered.add(relativePath);
    }
  }

  // A hotspot remains visible even when its file class is normally ignored.
  for (const hotspotPath of Object.keys(hotspots)) {
    if (fs.existsSync(path.join(root, hotspotPath))) discovered.add(hotspotPath);
  }

  const results = [];
  for (const relativePath of [...discovered].sort()) {
    const hotspot = hotspots[relativePath];
    const ignored = !hotspot && ignorePatterns.some((pattern) => pattern.test(relativePath));
    if (ignored) continue;

    const source = fs.readFileSync(path.join(root, relativePath), "utf8");
    const lines = countLines(source);
    const category = hotspot?.category ?? classifyFile(relativePath);
    const target = hotspot?.targetLines ?? config.limits[category] ?? config.limits.source;
    const ceiling = hotspot?.ceilingLines ?? target;

    let baseLines = null;
    if (!hotspot && lines > target && gitContext.baseRef) {
      const baseSource = readBaseSource(gitContext, relativePath);
      if (baseSource != null) baseLines = countLines(baseSource);
    }

    let status = evaluateFile({
      lines,
      target,
      ceiling,
      baseLines,
      hotspot: Boolean(hotspot),
    });

    // A shallow/local checkout without a base can still enforce explicit hotspot
    // ceilings. It reports unknown legacy oversize rather than blocking work with
    // a false "new file" result. CI fetches two commits, so this is enforceable there.
    if (!hotspot && lines > target && !gitContext.baseRef) status = "unverified";

    results.push({
      path: relativePath,
      category,
      lines,
      baseLines,
      target,
      ceiling,
      status,
      reason: hotspot?.reason ?? (
        status === "new-oversized"
          ? "New oversized file. Split it or add a reviewed, temporary hotspot ceiling."
          : status === "fail"
            ? "This legacy oversized file grew. It may stay the same size or shrink, but it may not grow."
            : ""
      ),
      nextBoundary: hotspot?.nextBoundary ?? "",
    });
  }
  return results;
}

function printHumanReport(results, gitContext) {
  const failures = results.filter((result) => result.status === "fail" || result.status === "new-oversized");
  const ratchets = results.filter((result) => result.status === "ratchet");
  const grandfathered = results.filter((result) => result.status === "grandfathered");
  const unverified = results.filter((result) => result.status === "unverified");

  console.log(
    `Maintainability ratchet scanned ${results.length} source files` +
      (gitContext.baseRef ? ` against ${gitContext.baseRef}.` : "."),
  );

  for (const result of failures) {
    const comparison = result.baseLines == null ? "new file" : `base ${result.baseLines}`;
    console.error(
      `FAIL ${result.path}: ${result.lines} lines; target ${result.target}; ${comparison} (${result.category})`,
    );
    if (result.reason) console.error(`  ${result.reason}`);
    if (result.nextBoundary) console.error(`  Next boundary: ${result.nextBoundary}`);
  }

  for (const result of ratchets) {
    console.log(
      `RATCHET ${result.path}: ${result.lines} lines; target ${result.target}, ceiling ${result.ceiling}`,
    );
    if (result.nextBoundary) console.log(`  Next boundary: ${result.nextBoundary}`);
  }

  if (grandfathered.length > 0) {
    console.log(`PASS ${grandfathered.length} legacy oversized file(s) did not grow.`);
  }
  if (unverified.length > 0) {
    console.warn(
      `WARN ${unverified.length} oversized file(s) could not be compared because no Git base was available. ` +
      "Explicit hotspot ceilings were still enforced.",
    );
  }
  if (failures.length === 0) {
    console.log(`PASS no maintainability ceiling or no-growth rule was violated; ${ratchets.length} named hotspot(s) remain.`);
  }
  return failures.length;
}

function main() {
  if (process.argv.includes("--self-test")) {
    runSelfTest();
    return;
  }

  const root = process.cwd();
  const config = loadConfig(root);
  const gitContext = resolveGitContext(root);
  const results = audit(root, config, gitContext);
  const failures = results.filter(
    (result) => result.status === "fail" || result.status === "new-oversized",
  );

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({
      baseRef: gitContext.baseRef,
      scanned: results.length,
      failures,
      ratchets: results.filter((result) => result.status === "ratchet"),
      grandfathered: results.filter((result) => result.status === "grandfathered"),
      unverified: results.filter((result) => result.status === "unverified"),
    }, null, 2));
  } else {
    printHumanReport(results, gitContext);
  }

  if (failures.length > 0) process.exitCode = 1;
}

main();
