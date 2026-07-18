"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { LunaLogo } from "@/components/ui/luna-logo";
import { useErrorCopy } from "@/lib/i18n/error-copy";

// Routes-level error boundary. Uses the static `ERROR_COPY` table from
// `lib/i18n/error-copy.ts` instead of `useT()`: this boundary catches errors
// thrown by every page including the I18nProvider itself, so depending on the
// translation system inside the fallback would invite a second crash during
// recovery. The locale read is best-effort (navigator.language) so the page
// still renders even if no provider ever mounted.

export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const copy = useErrorCopy();

  // Keep the raw error out of the UI (it can leak internals / read as noise to
  // users) but preserve it for debugging via the console.
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-(--bg-base) px-6">
      <LunaLogo size={40} className="text-(--text-tertiary)" />
      <div className="text-center">
        <h1 className="text-2xl font-light text-(--text-primary)">
          {copy.title}
        </h1>
        <p className="mt-2 text-sm text-(--text-secondary)">
          {copy.unexpected}
        </p>
      </div>
      <Button type="button" onClick={reset} variant="outline">
        {copy.retry}
      </Button>
    </main>
  );
}
