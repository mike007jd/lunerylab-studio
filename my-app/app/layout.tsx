import type { Metadata, Viewport } from "next";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { MotionProvider } from "@/components/motion/motion-provider";
import { NavigationFeedback } from "@/components/motion/navigation-feedback";
import { I18nProvider } from "@/lib/i18n/provider";
import "./globals.css";

import { getMessages, resolveLocale } from "@/lib/i18n/server";

export function generateMetadata(): Metadata {
  return {
    title: {
      default: "Lunery Lab Studio",
      template: "%s — Lunery Lab Studio",
    },
    description: "Local-first creative Studio for images, video, and canvas workflows.",
    robots: {
      index: false,
      follow: false,
    },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

const resolveInitialLocale = resolveLocale;

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const initialLocale = await resolveInitialLocale();
  const initialMessages = getMessages(initialLocale);

  return (
    <html lang={initialLocale} className="dark">
      <body className="antialiased">
        <I18nProvider initialLocale={initialLocale} initialMessages={initialMessages}>
          <MotionProvider>
            <TooltipProvider>
              <NavigationFeedback />
              {children}
              <Toaster
                position="top-right"
                theme="dark"
                toastOptions={{
                  className: "!bg-(--bg-surface) !border-(--border-subtle) !text-(--text-primary)",
                }}
              />
            </TooltipProvider>
          </MotionProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
