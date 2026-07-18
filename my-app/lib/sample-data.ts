/**
 * Source-of-truth definitions for the built-in sample projects.
 * Used by `lib/server/sample-projects.ts` to seed real DB rows for new users.
 */

export interface SampleLayerDef {
  /** Relative path inside `public/` (no leading slash, no `..`). */
  source: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SampleProjectDef {
  /**
   * Stable i18n slot id. The seeder resolves
   * `samples.<id>.{projectName,sessionTitle,jobPrompt}` from the message
   * catalog, so the displayed copy is localized and the keys stay stable for
   * H4.4 to repoint at new subjects without touching this plumbing.
   */
  id: string;
  layers: SampleLayerDef[];
}

export const SAMPLE_SOURCE_MIME_TYPE = "image/webp";

export const SAMPLE_PROJECTS: SampleProjectDef[] = [
  {
    id: "character-world",
    layers: [
      { source: "showcase/demo-ref-girl.webp", x: 80, y: 80, width: 480, height: 480 },
      { source: "showcase/demo-ref-moon.webp", x: 600, y: 80, width: 480, height: 480 },
      { source: "showcase/demo-stylize-ink.webp", x: 340, y: 620, width: 480, height: 480 },
    ],
  },
  {
    id: "style-lab",
    layers: [
      { source: "showcase/demo-stylize-source.webp", x: 80, y: 120, width: 460, height: 460 },
      { source: "showcase/demo-stylize-oil.webp", x: 590, y: 120, width: 460, height: 460 },
      { source: "showcase/demo-stylize-abstract.webp", x: 335, y: 640, width: 460, height: 460 },
    ],
  },
  {
    id: "lifestyle-mood-board",
    layers: [
      { source: "samples/coffee-scene.webp", x: 80, y: 120, width: 520, height: 520 },
      { source: "samples/ceramic-vase.webp", x: 640, y: 120, width: 520, height: 520 },
    ],
  },
];
