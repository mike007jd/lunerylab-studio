#!/usr/bin/env node

import assert from "node:assert/strict";
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
        pattern += ".*";
        index += 1;
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

function runSelfTest() {
  assert.equal(countLines(""), 0);
  assert.equal(countLines("one"), 1);
  assert.equal(countLines("one\ntwo\n"), 2);
  assert.equal(countLines("one\r\ntwo\r\n"), 2);

  assert.equal(globToRegExp("**/*.test.ts").test("lib/a.test.ts"), true);
  assert.equal(globToRegExp("components/ui/**").test("components/ui/button.tsx"), true);
  assert.equal(globToRegExp("scripts/*.mjs").test("scripts/check.mjs"), true);
  assert.equal(globToRegExp("scripts/*.mjs").test("scripts/nested/check.mjs"), false);

  assert.equal(classifyFile("app/api/items/route.ts"), "route");
  assert.equal(classifyFile("hooks/useThing.ts"), "hook");
  assert.equal(classifyFile("components/Thing.tsx"), "react");
  assert.equal(classifyFile("src-tauri/src/lib.rs"), "rust");
  assert.equal(classifyFile("lib/thing.test.ts"), "test");

  console.log("PASS maintainability checker self-test");
}

function audit(root, config) {
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
    const ignored =
      !hotspot && ignorePatterns.some((pattern) => pattern.test(relativePath));
    if (ignored) continue;

    const source = fs.readFileSync(path.join(root, relativePath), "utf8");
    const lines = countLines(source);
    const category = hotspot?.category ?? classifyFile(relativePath);
    const defaultLimit = config.limits[category] ?? config.limits.source;

    if (hotspot) {
      const ceiling = hotspot.ceilingLines;
      const target = hotspot.targetLines ?? defaultLimit;
      const status = lines > ceiling
        ? "fail"
        : lines > target
          ? "ratchet"
          : "pass";
      results.push({
        path: relativePath,
        category,
        lines,
        target,
        ceiling,
        status,
        reason: hotspot.reason ?? "",
        nextBoundary: hotspot.nextBoundary ?? "",
      });
      continue;
    }

    results.push({
      path: relativePath,
      category,
      lines,
      target: defaultLimit,
      ceiling: defaultLimit,
      status: lines > defaultLimit ? "fail" : "pass",
      reason: lines > defaultLimit
        ? "Unregistered oversized file. Split it or add a reviewed, temporary ratchet entry."
        : "",
      nextBoundary: "",
    });
  }
  return results;
}

function printHumanReport(results) {
  const failures = results.filter((result) => result.status === "fail");
  const ratchets = results.filter((result) => result.status === "ratchet");

  console.log(`Maintainability ratchet scanned ${results.length} source files.`);

  for (const result of failures) {
    console.error(
      `FAIL ${result.path}: ${result.lines} lines; limit/ceiling ${result.ceiling} (${result.category})`,
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

  if (failures.length === 0) {
    console.log(
      `PASS no file exceeded its reviewed ceiling; ${ratchets.length} known hotspot(s) remain.`,
    );
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
  const results = audit(root, config);

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({
      scanned: results.length,
      failures: results.filter((result) => result.status === "fail"),
      ratchets: results.filter((result) => result.status === "ratchet"),
    }, null, 2));
  } else {
    const failureCount = printHumanReport(results);
    if (failureCount > 0) process.exitCode = 1;
  }
}

main();
