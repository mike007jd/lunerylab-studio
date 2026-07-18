import Link from "next/link";
import { Button } from "@/components/ui/button";
import { LunaLogo } from "@/components/ui/luna-logo";
import { isDesktopRuntime } from "@/lib/desktop-runtime";
import { getT, resolveLocale } from "@/lib/i18n/server";

export default async function NotFound() {
  const locale = await resolveLocale();
  const t = getT(locale);
  const desktop = isDesktopRuntime();

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-(--bg-base) px-6">
      <LunaLogo size={40} className="text-(--text-tertiary)" />
      <div className="text-center">
        <h1 className="text-4xl font-light text-(--text-primary)">404</h1>
        <p className="mt-2 text-sm text-(--text-secondary)">
          {t("notFound.description")}
        </p>
      </div>
      <Button asChild variant="outline">
        <Link href={desktop ? "/studio" : "/"}>
          {desktop ? t("notFound.ctaStudio") : t("notFound.ctaHome")}
        </Link>
      </Button>
    </main>
  );
}
