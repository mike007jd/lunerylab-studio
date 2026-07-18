/**
 * Platform size presets — named, pixel-accurate output sizes for the major
 * channels creators ship to (social, ads, web).
 *
 * Each preset:
 *   - resolves to a concrete (width × height) for export
 *   - declares its aspect ratio so generation models pick the right canvas
 *   - lists a preferred output mime so JPEG-friendly platforms don't get PNG
 *
 * The Studio composer + Canvas export popover + agent tools all read from
 * this single source of truth. To add a platform, append a row — UI grouping
 * is derived from `category`.
 */

export type PlatformSizeCategory =
  | "social"
  | "ad"
  | "web"
  | "print";

export interface PlatformSizePreset {
  id: string;
  /** Display label, English. */
  label: string;
  /** Display label, simplified Chinese. */
  labelZh: string;
  category: PlatformSizeCategory;
  /** Brand / channel name (e.g. "Instagram", "TikTok"). Used as group header. */
  platform: string;
  width: number;
  height: number;
  /** Aspect ratio string compatible with our model APIs ("1:1", "9:16"…). */
  aspectRatio: string;
  /** Recommended export mime. JPEG is smaller for photo-heavy platforms. */
  preferredMime: "image/png" | "image/jpeg" | "image/webp";
  /** Soft cap (bytes). Used by export pipeline to nudge quality settings. */
  maxBytes?: number;
}

// Reduce a `width:height` to its lowest terms for canonical aspect labels.
function reduceAspect(width: number, height: number): string {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const factor = gcd(width, height);
  return `${width / factor}:${height / factor}`;
}

export const PLATFORM_SIZES: readonly PlatformSizePreset[] = [
  // TikTok ----------------------------------------------------------------
  {
    id: "tiktok-reel",
    label: "TikTok Vertical",
    labelZh: "TikTok 竖屏",
    category: "social",
    platform: "TikTok",
    width: 1080,
    height: 1920,
    aspectRatio: "9:16",
    preferredMime: "image/jpeg",
  },
  {
    id: "tiktok-square",
    label: "TikTok Square",
    labelZh: "TikTok 方图",
    category: "social",
    platform: "TikTok",
    width: 1080,
    height: 1080,
    aspectRatio: "1:1",
    preferredMime: "image/jpeg",
  },

  // Instagram -------------------------------------------------------------
  {
    id: "ig-post-square",
    label: "Instagram Post (Square)",
    labelZh: "Instagram 方图",
    category: "social",
    platform: "Instagram",
    width: 1080,
    height: 1080,
    aspectRatio: "1:1",
    preferredMime: "image/jpeg",
  },
  {
    id: "ig-post-portrait",
    label: "Instagram Post (Portrait)",
    labelZh: "Instagram 竖图",
    category: "social",
    platform: "Instagram",
    width: 1080,
    height: 1350,
    aspectRatio: reduceAspect(1080, 1350), // 4:5
    preferredMime: "image/jpeg",
  },
  {
    id: "ig-story",
    label: "Instagram Story / Reel",
    labelZh: "Instagram Story / Reel",
    category: "social",
    platform: "Instagram",
    width: 1080,
    height: 1920,
    aspectRatio: "9:16",
    preferredMime: "image/jpeg",
  },

  // Pinterest -------------------------------------------------------------
  {
    id: "pinterest-pin",
    label: "Pinterest Pin",
    labelZh: "Pinterest Pin",
    category: "social",
    platform: "Pinterest",
    width: 1000,
    height: 1500,
    aspectRatio: "2:3",
    preferredMime: "image/jpeg",
  },
  {
    id: "pinterest-idea",
    label: "Pinterest Idea Pin",
    labelZh: "Pinterest Idea Pin",
    category: "social",
    platform: "Pinterest",
    width: 1080,
    height: 1920,
    aspectRatio: "9:16",
    preferredMime: "image/jpeg",
  },

  // Facebook / X ----------------------------------------------------------
  {
    id: "fb-feed",
    label: "Facebook Feed",
    labelZh: "Facebook 信息流",
    category: "social",
    platform: "Facebook",
    width: 1200,
    height: 1200,
    aspectRatio: "1:1",
    preferredMime: "image/jpeg",
  },
  {
    id: "x-post",
    label: "X / Twitter Post",
    labelZh: "X / Twitter 推文",
    category: "social",
    platform: "X",
    width: 1600,
    height: 900,
    aspectRatio: "16:9",
    preferredMime: "image/jpeg",
  },

  // YouTube ---------------------------------------------------------------
  {
    id: "youtube-thumb",
    label: "YouTube Thumbnail",
    labelZh: "YouTube 视频缩略图",
    category: "social",
    platform: "YouTube",
    width: 1280,
    height: 720,
    aspectRatio: "16:9",
    preferredMime: "image/jpeg",
    maxBytes: 2 * 1024 * 1024,
  },

  // Ads ------------------------------------------------------------------
  {
    id: "google-ad-square",
    label: "Google Display Ad (Square)",
    labelZh: "Google 展示广告 (方图)",
    category: "ad",
    platform: "Google Ads",
    width: 1200,
    height: 1200,
    aspectRatio: "1:1",
    preferredMime: "image/jpeg",
  },
  {
    id: "google-ad-landscape",
    label: "Google Display Ad (Landscape)",
    labelZh: "Google 展示广告 (横图)",
    category: "ad",
    platform: "Google Ads",
    width: 1200,
    height: 628,
    aspectRatio: reduceAspect(1200, 628), // ~1.91:1
    preferredMime: "image/jpeg",
  },

  // Web / OG -------------------------------------------------------------
  {
    id: "og-image",
    label: "Open Graph",
    labelZh: "Open Graph 分享图",
    category: "web",
    platform: "Web",
    width: 1200,
    height: 630,
    aspectRatio: reduceAspect(1200, 630),
    preferredMime: "image/jpeg",
  },
] as const;

export const PLATFORM_SIZES_BY_ID: Record<string, PlatformSizePreset> =
  PLATFORM_SIZES.reduce<Record<string, PlatformSizePreset>>((acc, preset) => {
    acc[preset.id] = preset;
    return acc;
  }, {});

export function findPlatformSize(id: string): PlatformSizePreset | undefined {
  return PLATFORM_SIZES_BY_ID[id];
}
