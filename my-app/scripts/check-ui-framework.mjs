import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const configPath = path.join(root, "ui-framework.config.json");
const scanRoots = ["app", "components", "lib"].map((dir) => path.join(root, dir));
const frameworkRoot = path.join(root, "components", "design-system");

const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const baseline = config.baselines;

const fileExtensions = new Set([".ts", ".tsx", ".css"]);
const ignoredSegments = new Set(["node_modules", ".next", "desktop-server", "desktop-dist"]);

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

const bareButtonAllowedFiles = new Set([
  "components/ui/button.tsx",
  "components/ui/sidebar.tsx",
]);

function isDirectLucideImportAllowed(file) {
  return relative(file).startsWith("components/ui/");
}

function isMotionGrammar(file) {
  return relative(file) === "components/design-system/grammar/motion.ts";
}

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignoredSegments.has(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, files);
      continue;
    }

    // Tests deliberately construct violations (red-tests, regression fixtures);
    // the gate governs product source.
    if (fileExtensions.has(path.extname(entry.name)) && !/\.test\.tsx?$/.test(entry.name)) {
      files.push(fullPath);
    }
  }

  return files;
}

function relative(file) {
  return path.relative(root, file);
}

function isGlobals(file) {
  return relative(file) === "app/globals.css";
}

function countLineMatches(files, pattern, { excludeGlobals = false, allowFile = () => false } = {}) {
  let count = 0;
  const hits = [];

  for (const file of files) {
    if (excludeGlobals && isGlobals(file)) continue;
    if (allowFile(file)) continue;
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);

    lines.forEach((line, index) => {
      if (pattern.test(line)) {
        count += 1;
        hits.push(`${relative(file)}:${index + 1}`);
      }
    });
  }

  return { count, hits };
}

const files = scanRoots.flatMap((dir) => walk(dir));
const frameworkFiles = walk(frameworkRoot);

// ---------------------------------------------------------------------------
// Design invariants (see .ai/loops/design-invariants.md).
//
// Each rule below is the machine half of one invariant: it pins the canonical
// implementation in place so the same drift class cannot be reintroduced by the
// next incremental change.
// ---------------------------------------------------------------------------

function read(file) {
  return fs.readFileSync(path.resolve(root, file), "utf8");
}

/** JSX element blocks for a component tag, self-closing or paired. */
function elementBlocks(source, tag) {
  const blocks = [];
  const opening = new RegExp(`<${tag}\\b`, "g");
  let match;
  while ((match = opening.exec(source))) {
    const openEnd = source.indexOf(">", match.index);
    if (openEnd === -1) continue;
    const selfClosing = source[openEnd - 1] === "/";
    const close = selfClosing
      ? openEnd + 1
      : (() => {
          const closeIndex = source.indexOf(`</${tag}>`, openEnd);
          return closeIndex === -1 ? openEnd + 1 : closeIndex + tag.length + 3;
        })();
    blocks.push({
      index: match.index,
      line: source.slice(0, match.index).split(/\r?\n/).length,
      openTag: source.slice(match.index, openEnd + 1),
      children: selfClosing ? "" : source.slice(openEnd + 1, close - tag.length - 3),
    });
  }
  return blocks;
}

/** INV-DD-05 (caller half) + INV-DD-07 (consumer half): whole-repo JSX rules. */
function jsxInvariantHits(fileList) {
  const spinnerInButton = [];
  const loadingChildSwap = [];
  const fieldRadiusOverride = [];

  for (const file of fileList) {
    const rel = relative(file);
    if (!rel.endsWith(".tsx")) continue;
    const source = fs.readFileSync(file, "utf8");

    for (const block of elementBlocks(source, "Button")) {
      if (/animate-spin/.test(block.children)) {
        spinnerInButton.push(`${rel}:${block.line} in-flow spinner inside <Button>`);
      }
      const loading = block.openTag.match(/loading=\{([^}]+)\}/);
      if (loading) {
        const expression = loading[1].trim();
        if (expression && block.children.includes(expression)) {
          loadingChildSwap.push(
            `${rel}:${block.line} <Button> children branch on its own loading state (${expression})`,
          );
        }
      }
    }

    for (const tag of ["Input", "Textarea", "SelectTrigger"]) {
      for (const block of elementBlocks(source, tag)) {
        if (/\brounded-/.test(block.openTag)) {
          fieldRadiusOverride.push(`${rel}:${block.line} <${tag}> overrides the field radius`);
        }
      }
    }
  }

  return { spinnerInButton, loadingChildSwap, fieldRadiusOverride };
}

const jsx = jsxInvariantHits(files);

const RUNTIME_ROW_CHROME = "flex flex-wrap items-start gap-3 rounded-xl bg-(--bg-glass) px-3 py-2.5";

function fileRule(id, file, { require: required = [], forbid = [] }) {
  const source = read(file);
  const hits = [];
  for (const [pattern, why] of required) {
    if (!pattern.test(source)) hits.push(`${id} ${file}: missing ${why}`);
  }
  for (const [pattern, why] of forbid) {
    if (pattern.test(source)) hits.push(`${id} ${file}: forbidden ${why}`);
  }
  return hits;
}

/**
 * INV-DD-05 (icon-padding half): a size's icon padding may only be triggered by
 * the caller's own icon — a direct `> svg` (asChild) or an svg inside
 * `button-content`. Any other `has-…:px-*` selector (notably a bare `has-[svg]`)
 * also matches the loading overlay's spinner svg, which shrinks the padding of a
 * text-only button the moment it starts loading.
 */
function buttonIconPaddingHits() {
  const file = "components/ui/button.tsx";
  const source = read(file);
  const allowed = new Set([">svg", "[data-slot=button-content]_svg"]);
  const hits = [];
  const byPadding = new Map();

  const variant = /has-\[((?:[^[\]]|\[[^\]]*\])*)\]:px-([\d.]+)/g;
  let match;
  while ((match = variant.exec(source))) {
    const [, selector, padding] = match;
    const line = source.slice(0, match.index).split(/\r?\n/).length;
    if (!allowed.has(selector)) {
      hits.push(
        `INV-DD-05 ${file}:${line}: icon padding selector \`has-[${selector}]\` also matches the loading spinner svg`,
      );
      continue;
    }
    if (!byPadding.has(padding)) byPadding.set(padding, new Set());
    byPadding.get(padding).add(selector);
  }

  for (const [padding, selectors] of byPadding) {
    for (const required of allowed) {
      if (!selectors.has(required)) {
        hits.push(
          `INV-DD-05 ${file}: size padding px-${padding} is missing the \`has-[${required}]\` icon selector`,
        );
      }
    }
  }

  return hits;
}

function invariantHits() {
  const hits = [];

  // INV-DD-01 — a persistent chat asset action resolves against current Canvas
  // state and exposes a visible unavailable path.
  hits.push(
    ...fileRule("INV-DD-01", "components/canvas/canvas-page.tsx", {
      require: [
        [
          /const handleFocusAsset = useCallback\([\s\S]{0,500}?if \(!layer\)[\s\S]{0,200}?toast\.error/,
          "handleFocusAsset miss branch with user feedback",
        ],
        [/const isAssetAvailable = useCallback\(/, "isAssetAvailable resolver"],
        [/isAssetAvailable=\{isAssetAvailable\}/, "availability passed to the chat panel"],
      ],
    }),
    ...fileRule("INV-DD-01", "components/studio/agent-chat/agent-message-parts.tsx", {
      require: [
        [/isAssetAvailable/, "asset availability in the chat UI contract"],
        [/data-slot="agent-asset-stale"/, "visible unavailable marker on stale assets"],
      ],
    }),
  );

  // INV-DD-02 — media failures always terminate loading and render a visible
  // unavailable state, with or without a caller fallback.
  hits.push(
    ...fileRule("INV-DD-02", "components/ui/asset-image.tsx", {
      require: [
        [/onError=\{\(\) => setFailedSrc\(src\)\}/, "unconditional error handler"],
        [/data-slot="asset-image-unavailable"/, "default unavailable state"],
      ],
      forbid: [[/onError=\{fallback/, "fallback-conditional error handling"]],
    }),
  );

  // INV-DD-03 — a first-load asset error blocks the region and offers retry; it
  // is never rendered as (or alongside) the true empty state.
  hits.push(
    ...fileRule("INV-DD-03", "components/library/project-workspace.tsx", {
      require: [
        [/const assetsBlocked = /, "blocking first-load asset-error state"],
        [/assetsBlocked \? \([\s\S]{0,400}?role="alert"/, "alert semantics on the blocking branch"],
        [/assetsBlocked \? \([\s\S]{0,800}?setAssetReloadToken/, "retry action on the blocking branch"],
        [/!assetLoading &&\s*!assetError;/, "empty state excludes the error state"],
      ],
    }),
  );
  {
    const source = read("components/library/project-workspace.tsx");
    const blocking = source.indexOf("assetsBlocked ? (");
    const tabs = source.indexOf("<LibraryAssetTabs");
    if (blocking === -1 || tabs === -1 || blocking > tabs) {
      hits.push(
        "INV-DD-03 components/library/project-workspace.tsx: blocking asset-error branch must precede LibraryAssetTabs",
      );
    }
  }

  // INV-DD-04 — a routed surface shows visible loading structure instead of
  // hiding itself while it hydrates.
  hits.push(
    ...fileRule("INV-DD-04", "components/studio/studio-page.tsx", {
      require: [
        [/data-slot="studio-loading-shell"/, "visible hydration loading shell"],
        [/aria-busy="true"/, "aria-busy on the loading shell"],
      ],
      forbid: [[/hydrated \? "visible" : "invisible"/, "hydration-dependent invisible surface root"]],
    }),
  );

  // INV-DD-05 — Button loading preserves the border-box footprint; features may
  // not hand-roll spinners or swap children on their own loading flag.
  hits.push(
    ...fileRule("INV-DD-05", "components/ui/button.tsx", {
      require: [
        [/data-slot="button-spinner"/, "overlaid spinner"],
        [/absolute inset-0 flex items-center justify-center/, "spinner overlay outside the flow"],
        [/data-slot="button-content"/, "preserved child footprint"],
        [/cn\("contents", loading && "invisible"\)/, "children hidden without collapsing their space"],
      ],
      forbid: [
        [
          /has-\[svg\]:/,
          "icon padding matched on any descendant svg — the overlay spinner is an svg, so this shrinks a text-only button's padding while it loads",
        ],
      ],
    }),
    ...buttonIconPaddingHits(),
    ...jsx.spinnerInButton.map((hit) => `INV-DD-05 ${hit}`),
    ...jsx.loadingChildSwap.map((hit) => `INV-DD-05 ${hit}`),
  );

  // INV-DD-06 — the preset trigger is width-bounded and truncates.
  hits.push(
    ...fileRule("INV-DD-06", "components/studio/studio-preset-picker.tsx", {
      require: [
        [/"h-8 w-40 justify-between/, "width-bounded preset trigger"],
        [/min-w-0 flex-1 truncate/, "truncated selected-preset name"],
      ],
    }),
  );

  // INV-DD-07 — same-role form fields share the Luna field radius at the
  // primitive boundary, and consumers may not override it.
  hits.push(
    ...fileRule("INV-DD-07", "components/ui/select.tsx", {
      require: [[/justify-between gap-2 rounded-xl border border-input/, "rounded-xl SelectTrigger"]],
    }),
    ...fileRule("INV-DD-07", "components/ui/input.tsx", {
      require: [[/rounded-xl/, "rounded-xl Input"]],
    }),
    ...fileRule("INV-DD-07", "components/ui/textarea.tsx", {
      require: [[/rounded-xl/, "rounded-xl Textarea"]],
    }),
    ...jsx.fieldRadiusOverride.map((hit) => `INV-DD-07 ${hit}`),
  );

  // INV-DD-08 — one runtime-health row implementation; behaviour differences are
  // typed view data plus an optional action.
  hits.push(
    ...fileRule("INV-DD-08", "components/settings/runtime-health-row.tsx", {
      require: [[/data-slot="runtime-health-row"/, "the shared runtime row"]],
    }),
    ...fileRule("INV-DD-08", "components/settings/runtime-health-panel.tsx", {
      require: [[/<RuntimeHealthRow/, "runtimes rendered through the shared row"]],
    }),
  );
  {
    const owners = files.filter((file) => fs.readFileSync(file, "utf8").includes(RUNTIME_ROW_CHROME));
    if (owners.length > 1) {
      hits.push(
        ...owners.map(
          (file) => `INV-DD-08 ${relative(file)}: duplicate runtime-health row chrome`,
        ),
      );
    }
  }

  // INV-DD-09 — mobile chrome sharing a screen edge uses one natural-flow lane
  // instead of guessing a sibling's height.
  hits.push(
    ...fileRule("INV-DD-09", "components/canvas/canvas-page.tsx", {
      require: [[/data-slot="canvas-mobile-bottom-lane"/, "the shared mobile bottom lane"]],
      forbid: [
        [/\?\s*"bottom-\d+"\s*:\s*"bottom-\d+"/, "state-driven bottom-* compensation"],
        [/selectedLayerId \? "bottom-/, "selection-driven bottom offset"],
      ],
    }),
  );

  // INV-DD-10 — runtime checking / ready / unreachable / missing stay
  // distinguishable; a boolean cannot express four states.
  hits.push(
    ...fileRule("INV-DD-10", "components/settings/desktop-runtime/badges.tsx", {
      require: [
        [
          /export type RuntimeBadgeState =\s*\|?\s*"checking"\s*\|\s*"ready"\s*\|\s*"unreachable"\s*\|\s*"missing"/,
          "typed four-state union",
        ],
        [/case "checking":/, "distinct checking visual"],
        [/case "unreachable":/, "distinct unreachable visual"],
        [/case "missing":/, "distinct missing visual"],
      ],
      forbid: [[/active: boolean/, "boolean runtime state"]],
    }),
  );
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    if (/<RuntimeBadge\s+active=/.test(source)) {
      hits.push(`INV-DD-10 ${relative(file)}: RuntimeBadge used with a boolean active prop`);
    }
  }

  return hits;
}

const invariants = invariantHits();

const checks = [
  {
    name: "required framework files",
    result: {
      count: config.requiredFiles.filter((file) => !fs.existsSync(path.resolve(root, file))).length,
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
      allowFile: (file) => bareButtonAllowedFiles.has(relative(file)),
    }),
    max: baseline.bareButton,
  },
  {
    name: "direct lucide-react imports outside ui primitives",
    result: countLineMatches(files, patterns.directLucideImport, {
      allowFile: isDirectLucideImportAllowed,
    }),
    max: 0,
  },
  // Landing is an intentionally frozen deletion batch. Once it lands,
  // transitionAll must tighten from 1 to 0 and the Framer exceptions vanish.
  // For future legitimate hits (for example a Sonner toast duration), name the
  // value in the motion grammar or allow that file; never weaken these regexes.
  {
    name: "Framer duration literals outside motion grammar",
    result: countLineMatches(
      files.filter((file) => path.extname(file) !== ".css"),
      patterns.framerDurationLiteral,
      { allowFile: (file) => isMotionGrammar(file) },
    ),
    max: baseline.framerDurationLiteral,
  },
  {
    name: "Framer easing literals outside motion grammar",
    result: countLineMatches(
      files.filter((file) => path.extname(file) !== ".css"),
      patterns.framerEaseLiteral,
      { allowFile: (file) => isMotionGrammar(file) },
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
    result: countLineMatches(files, patterns.rawCubicBezier, { excludeGlobals: true }),
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
  {
    name: "design invariants (.ai/loops/design-invariants.md)",
    result: { count: invariants.length, hits: invariants },
    max: 0,
  },
];

let failed = false;

for (const check of checks) {
  const { count, hits } = check.result;
  const status = count <= check.max ? "PASS" : "FAIL";
  console.log(`${status} ${check.name}: ${count}/${check.max}`);

  if (count > check.max) {
    failed = true;
    for (const hit of hits.slice(0, 20)) {
      console.log(`  ${hit}`);
    }
    if (hits.length > 20) {
      console.log(`  ...and ${hits.length - 20} more`);
    }
  }
}

if (failed) {
  process.exit(1);
}
