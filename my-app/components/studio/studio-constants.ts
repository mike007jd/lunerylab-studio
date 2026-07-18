import type { StylePreset } from "@/lib/presets/style-presets";

export interface ProjectOption {
  id: string;
  name: string;
}

export const DEFAULT_SCENE_MODE = "general" as const;
export const MAX_REFERENCE_FILES = 20;

// The reference deck is absolutely positioned over the composer's top-left, so
// the textarea must reserve left space for it. The deck is a fixed size at every
// breakpoint, so the reservation must apply at every breakpoint too — gating it
// behind `md:` left the mobile placeholder rendering *behind* the "+" thumbnail.
export const COMPOSER_DECK_LAYOUT_CLASS =
  "[--composer-deck-footprint:10rem] [--composer-deck-offset:calc(var(--composer-deck-footprint)+1rem)]";
export const COMPOSER_DECK_FOOTPRINT_WIDTH_CLASS = "w-[var(--composer-deck-footprint)]";
export const COMPOSER_TEXTAREA_OFFSET_CLASS = "pl-[var(--composer-deck-offset)]";

// Preset-picker tone accents reference named tokens in globals.css
// (--preset-tone-*) so the raw rgba values live in the single token file rather
// than being inlined here. Each tone maps to a card bg, dot-grid dot, and label.
export const TONE_ACCENT: Record<StylePreset["previewTone"], { bg: string; dot: string; label: string }> = {
  sand: { bg: "var(--preset-tone-sand-bg)", dot: "var(--preset-tone-sand-dot)", label: "var(--preset-tone-sand-label)" },
  mint: { bg: "var(--preset-tone-mint-bg)", dot: "var(--preset-tone-mint-dot)", label: "var(--preset-tone-mint-label)" },
  sky: { bg: "var(--preset-tone-sky-bg)", dot: "var(--preset-tone-sky-dot)", label: "var(--preset-tone-sky-label)" },
  rose: { bg: "var(--preset-tone-rose-bg)", dot: "var(--preset-tone-rose-dot)", label: "var(--preset-tone-rose-label)" },
  lavender: { bg: "var(--preset-tone-lavender-bg)", dot: "var(--preset-tone-lavender-dot)", label: "var(--preset-tone-lavender-label)" },
  sage: { bg: "var(--preset-tone-sage-bg)", dot: "var(--preset-tone-sage-dot)", label: "var(--preset-tone-sage-label)" },
};
