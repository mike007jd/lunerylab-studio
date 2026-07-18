"use client";

import { useCallback, useState, type CSSProperties, type ReactNode } from "react";

import { ImageOff } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

/**
 * Renders a private asset stream (`/api/assets/[id]`) as a plain `<img>`.
 *
 * next/image is deliberately avoided: these are authenticated API streams its
 * optimizer can't proxy — it returns 400 and the image breaks. Centralizing the
 * plain `<img>` (with its eslint-disable and lazy/async defaults) keeps every
 * asset surface — board cards, the Studio results grid, agent-chat thumbnails —
 * on one implementation instead of copy-pasted `<img>` tags that drift apart.
 *
 * A failed stream (moved/deleted file → 404) always terminates loading and
 * renders a visible unavailable state. Callers may pass `fallback` to replace
 * that default with a surface-specific placeholder, but they can never opt out
 * of failure handling: a missing image must never stay an invisible ghost.
 */
export function AssetImage({
  src,
  alt,
  className,
  style,
  priority = false,
  fallback,
}: {
  src: string;
  alt: string;
  className?: string;
  style?: CSSProperties;
  priority?: boolean;
  fallback?: ReactNode;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  // Cached/eager images can be `complete` before React attaches onLoad — check
  // on the ref so the fade never gets stuck at opacity-0 (invisible image).
  const measureRef = useCallback((node: HTMLImageElement | null) => {
    if (node?.complete) setLoaded(true);
  }, []);

  if (failedSrc === src) {
    return (
      <>
        {fallback ?? (
          <span
            data-slot="asset-image-unavailable"
            role="img"
            aria-label={alt}
            className={cn(
              "flex flex-col items-center justify-center gap-1.5 bg-(--bg-elevated) text-(--text-muted)",
              className,
            )}
            style={style}
          >
            <ImageOff className="h-5 w-5" aria-hidden="true" />
          </span>
        )}
      </>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={measureRef}
      src={src}
      alt={alt}
      loading={priority ? "eager" : "lazy"}
      decoding="async"
      onLoad={() => setLoaded(true)}
      onError={() => setFailedSrc(src)}
      style={style}
      // Layout-neutral fade-in: avoids the blank→pop flash without touching the
      // caller's sizing/positioning classes.
      className={cn(
        "transition-opacity duration-(--motion-surface)",
        loaded ? "opacity-100" : "opacity-0",
        className,
      )}
    />
  );
}
