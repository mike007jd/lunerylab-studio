import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const config = JSON.parse(
  fs.readFileSync(path.join(root, "ui-framework.config.json"), "utf8"),
);
const scanRoots = ["app", "components", "hooks", "lib"].map((dir) => path.join(root, dir));
const frameworkRoot = path.join(root, "components", "design-system");
const extensions = new Set([".ts", ".tsx", ".css"]);
const ignoredSegments = new Set([
  "node_modules",
  ".next",
  "desktop-server",
  "desktop-dist",
]);

const patterns = {
  rawColor: /#[0-9a-fA-F]{3,8}\b|rgba?\(/,
  arbitraryUtility:
    /\b(?:bg|text|border|from|via|to|w|h|min-w|max-w|min-h|max-h|p|px|py|m|mx|my|gap|rounded|shadow|leading|tracking|top|left|right|bottom|translate-x|translate-y|size)-\[/,
  nonSemanticPalette:
    /\b(?:bg|text|border|from|via|to|ring|fill|stroke)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-/,
  secondStylingSystem: /(?:styled-components|@emotion\/(?:react|styled)|\.module\.css)/,
  bareButton: /<button\b/,
  directLucideImport: /from\s+["']lucide-react["']/,
  framerDurationLiteral: /\bduration:\s*\d/,
  framerEaseLiteral: /\bease:\s*\[/,
  transitionAllUtility: /\btransition-all\b/,
  rawCubicBezier: /cubic-bezier\(/,
};

function relative(file) {
  return path.relative(root, file);
}

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignoredSegments.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, files);
    } else if (
      extensions.has(path.extname(entry.name)) &&
      !/\.test\.tsx?$/.test(entry.name)
    ) {
      files.push(fullPath);
    }
  }
  return files;
}

function countLineMatches(
  files,
  pattern,
  { excludeGlobals = false, allowFile = () => false } = {},
) {
  let count = 0;
  const hits = [];
  for (const file of files) {
    if (excludeGlobals && relative(file) === "app/globals.css") continue;
    if (allowFile(file)) continue;
    fs.readFileSync(file, "utf8")
      .split(/\r?\n/)
      .forEach((line, index) => {
        if (!pattern.test(line)) return;
        count += 1;
        hits.push(`${relative(file)}:${index + 1}`);
      });
  }
  return { count, hits };
}

const files = scanRoots.flatMap((dir) => walk(dir));
const frameworkFiles = walk(frameworkRoot);
const baseline = config.baselines;
const bareButtonAllowed = new Set([
  "components/ui/button.tsx",
  "components/ui/sidebar.tsx",
]);

const checks = [
  {
    name: "required framework files",
    result: {
      count: config.requiredFiles.filter(
        (file) => !fs.existsSync(path.resolve(root, file)),
      ).length,
      hits: config.requiredFiles
        .filter((file) => !fs.existsSync(path.resolve(root, file)))
        .map((file) => `missing ${file}`),
    },
    max: 0,
  },
  {
    name: "second styling systems",
    result: countLineMatches(files, patterns.secondStylingSystem),
    max: baseline.secondStylingSystem,
  },
  {
    name: "non-semantic palette utilities",
    result: countLineMatches(files, patterns.nonSemanticPalette),
    max: baseline.nonSemanticPalette,
  },
  {
    name: "raw colors outside token file",
    result: countLineMatches(files, patterns.rawColor, { excludeGlobals: true }),
    max: baseline.rawColor,
  },
  {
    name: "arbitrary Tailwind utilities",
    result: countLineMatches(files, patterns.arbitraryUtility),
    max: baseline.arbitraryUtility,
  },
  {
    name: "bare button elements",
    result: countLineMatches(files, patterns.bareButton, {
      allowFile: (file) => bareButtonAllowed.has(relative(file)),
    }),
    max: baseline.bareButton,
  },
  {
    name: "direct lucide imports outside primitives",
    result: countLineMatches(files, patterns.directLucideImport, {
      allowFile: (file) => relative(file).startsWith("components/ui/"),
    }),
    max: 0,
  },
  {
    name: "Framer duration literals outside motion grammar",
    result: countLineMatches(
      files.filter((file) => path.extname(file) !== ".css"),
      patterns.framerDurationLiteral,
      {
        allowFile: (file) =>
          relative(file) === "components/design-system/grammar/motion.ts",
      },
    ),
    max: baseline.framerDurationLiteral,
  },
  {
    name: "Framer easing literals outside motion grammar",
    result: countLineMatches(
      files.filter((file) => path.extname(file) !== ".css"),
      patterns.framerEaseLiteral,
      {
        allowFile: (file) =>
          relative(file) === "components/design-system/grammar/motion.ts",
      },
    ),
    max: baseline.framerEaseLiteral,
  },
  {
    name: "transition-all utilities",
    result: countLineMatches(files, patterns.transitionAllUtility),
    max: baseline.transitionAll,
  },
  {
    name: "raw cubic-bezier outside globals",
    result: countLineMatches(files, patterns.rawCubicBezier, {
      excludeGlobals: true,
    }),
    max: baseline.rawCubicBezier,
  },
  {
    name: "framework raw colors",
    result: countLineMatches(frameworkFiles, patterns.rawColor),
    max: 0,
  },
  {
    name: "framework arbitrary Tailwind utilities",
    result: countLineMatches(frameworkFiles, patterns.arbitraryUtility),
    max: 0,
  },
  {
    name: "framework bare buttons",
    result: countLineMatches(frameworkFiles, patterns.bareButton),
    max: 0,
  },
];

let failed = false;
for (const check of checks) {
  const { count, hits } = check.result;
  const status = count <= check.max ? "PASS" : "FAIL";
  console.log(`${status} ${check.name}: ${count}/${check.max}`);
  if (count <= check.max) continue;
  failed = true;
  for (const hit of hits.slice(0, 20)) console.log(`  ${hit}`);
  if (hits.length > 20) console.log(`  ...and ${hits.length - 20} more`);
}

if (failed) process.exit(1);
