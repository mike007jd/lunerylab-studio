"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { LunaLogo } from "@/components/ui/luna-logo";
import { useErrorCopy } from "@/lib/i18n/error-copy";

// Root-level error boundary — replaces the entire layout on the most
// catastrophic crash, so it must stay self-sufficient (its own <html>/<body>)
// and visually match the per-route error.tsx so the same conceptual screen
// doesn't read as two different products. Global CSS tokens still apply here.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const copy = useErrorCopy();

  // Even the last line of defense should preserve the error for debugging.
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body className="flex min-h-screen flex-col items-center justify-center gap-6 bg-(--bg-base) px-6 text-(--text-primary)">
        <LunaLogo size={40} className="text-(--text-tertiary)" />
        <div className="text-center">
          <h1 className="text-2xl font-light text-(--text-primary)">{copy.title}</h1>
          <p className="mt-2 text-sm text-(--text-secondary)">{copy.unexpected}</p>
        </div>
        <Button type="button" onClick={() => reset()} variant="outline">
          {copy.retry}
        </Button>
      </body>
    </html>
  );
}
