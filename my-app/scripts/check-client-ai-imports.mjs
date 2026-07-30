#!/usr/bin/env node
/**
 * use-client-aware forbidden server AI import scan.
 *
 * Walks app/, components/, hooks/, and lib/client/. For modules that declare
 * `"use client"`, rejects server-only AI SDK imports. `@ai-sdk/react` is allowed.
 *
 * Also asserts failing fixtures under scripts/fixtures/client-ai-imports/ so the
 * gate cannot silently stop catching regressions.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(__dirname, "..");

const SCAN_ROOTS = ["app", "components", "hooks", "lib/client"].map((dir) =>
  path.join(appRoot, dir),
);
const FIXTURE_ROOT = path.join(__dirname, "fixtures", "client-ai-imports");

const FORBIDDEN = [
  "@ai-sdk/openai",
  "@ai-sdk/anthropic",
  "@ai-sdk/google",
  "@ai-sdk/openai-compatible",
  "@fal-ai/client",
  "replicate",
  "ai",
];
const ALLOWED = new Set(["@ai-sdk/react"]);

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.name === "node_modules" ||
      entry.name === ".next" ||
      entry.name.endsWith(".test.ts") ||
      entry.name.endsWith(".test.tsx")
    ) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name)) files.push(full);
  }
  return files;
}

function hasUseClient(source) {
  const sourceFile = ts.createSourceFile(
    "client-module.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  for (const statement of sourceFile.statements) {
    if (
      ts.isExpressionStatement(statement) &&
      ts.isStringLiteral(statement.expression)
    ) {
      if (statement.expression.text === "use client") return true;
      continue;
    }
    break;
  }
  return false;
}

function moduleSpecifierText(node) {
  return node && ts.isStringLiteralLike(node) ? node.text : null;
}

function findImportedModules(source) {
  const sourceFile = ts.createSourceFile(
    "client-module.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const modules = [];

  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = moduleSpecifierText(node.moduleSpecifier);
      if (specifier) modules.push(specifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const specifier = moduleSpecifierText(node.moduleReference.expression);
      if (specifier) modules.push(specifier);
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire =
        ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (isDynamicImport || isRequire) {
        const specifier = moduleSpecifierText(node.arguments[0]);
        if (specifier) modules.push(specifier);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return modules;
}

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs"];

function resolveLocalModule(fromFile, specifier) {
  let base;
  if (specifier.startsWith("@/")) {
    base = path.join(appRoot, specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    base = path.resolve(path.dirname(fromFile), specifier);
  } else {
    return null;
  }

  const relative = path.relative(appRoot, base);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  const candidates = [
    base,
    ...SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...SOURCE_EXTENSIONS.map((extension) => path.join(base, `index${extension}`)),
  ];
  return candidates.find((candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  }) ?? null;
}

function findForbiddenImportGraph(rootFile) {
  const hits = [];
  const visited = new Set();

  function visit(file, chain) {
    if (visited.has(file)) return;
    visited.add(file);
    const source = fs.readFileSync(file, "utf8");
    for (const specifier of findImportedModules(source)) {
      if (
        !ALLOWED.has(specifier) &&
        (FORBIDDEN.includes(specifier) ||
          FORBIDDEN.some((name) => specifier.startsWith(`${name}/`)))
      ) {
        hits.push({ specifier, chain });
        continue;
      }
      const resolved = resolveLocalModule(file, specifier);
      if (resolved) visit(resolved, [...chain, resolved]);
    }
  }

  visit(rootFile, [rootFile]);
  return hits;
}

function scanProduction() {
  const violations = [];
  for (const scanRoot of SCAN_ROOTS) {
    for (const file of walk(scanRoot)) {
      const source = fs.readFileSync(file, "utf8");
      if (!hasUseClient(source)) continue;
      for (const hit of findForbiddenImportGraph(file)) {
        const chain = hit.chain
          .map((entry) => path.relative(appRoot, entry))
          .join(" -> ");
        violations.push(
          `${path.relative(appRoot, file)} reaches forbidden server AI package "${hit.specifier}" via ${chain}`,
        );
      }
    }
  }
  return violations;
}

function assertFixturesFail() {
  if (!fs.existsSync(FIXTURE_ROOT)) {
    throw new Error(`Missing client AI import fixtures at ${FIXTURE_ROOT}`);
  }
  const fixtures = walk(FIXTURE_ROOT).filter((file) =>
    hasUseClient(fs.readFileSync(file, "utf8")),
  );
  if (fixtures.length === 0) {
    throw new Error("Expected failing fixtures for hooks and app client modules.");
  }
  const missed = [];
  for (const file of fixtures) {
    if (findForbiddenImportGraph(file).length === 0) {
      missed.push(path.relative(appRoot, file));
    }
  }
  if (missed.length > 0) {
    throw new Error(
      `Fixture(s) must be use-client modules with forbidden server AI imports: ${missed.join(", ")}`,
    );
  }
  return fixtures.length;
}

function main() {
  const fixtureCount = assertFixturesFail();
  const violations = scanProduction();
  if (violations.length > 0) {
    console.error("Forbidden server AI imports in use-client modules:");
    for (const line of violations) console.error(`  - ${line}`);
    process.exit(1);
  }
  console.log(`check-client-ai-imports: ok (fixtures=${fixtureCount})`);
}

main();
