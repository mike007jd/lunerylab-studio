type CanvasEntrySource = "studio" | "library" | `project:${string}`;

interface CanvasReturnTarget {
  href: "/studio" | "/library" | `/projects/${string}`;
  label: "studio" | "library" | "projects";
}

const CANVAS_RETURN_TARGETS = {
  studio: { href: "/studio", label: "studio" },
  library: { href: "/library", label: "library" },
} as const satisfies Record<"studio" | "library", CanvasReturnTarget>;

const SAFE_PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function parseProjectSource(source: string): string | null {
  if (!source.startsWith("project:")) return null;
  const projectId = source.slice("project:".length);
  return SAFE_PROJECT_ID.test(projectId) ? projectId : null;
}

/**
 * Add a trusted source marker to a Canvas URL while keeping navigation inside
 * the app. Any origin returned by an API is deliberately discarded.
 */
export function addCanvasEntrySource(
  canvasUrl: string,
  source: CanvasEntrySource,
): string {
  const url = new URL(canvasUrl, "https://lunery.local");
  if (!url.pathname.startsWith("/canvas/")) {
    throw new Error("Canvas session URL is outside the supported route.");
  }
  if (source !== "studio" && source !== "library" && !parseProjectSource(source)) {
    throw new Error("Canvas source is outside the supported return targets.");
  }
  url.searchParams.set("source", source);
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Canvas never treats a query value as a URL. Only exact, known source tokens
 * are mapped to fixed internal destinations; everything else falls back to
 * Library.
 */
export function resolveCanvasReturnTarget(source: string | null): CanvasReturnTarget {
  if (source === "studio") return CANVAS_RETURN_TARGETS.studio;
  if (source === "library") return CANVAS_RETURN_TARGETS.library;

  const projectId = source ? parseProjectSource(source) : null;
  if (projectId) {
    return {
      href: `/projects/${encodeURIComponent(projectId)}`,
      label: "projects",
    };
  }

  return CANVAS_RETURN_TARGETS.library;
}
