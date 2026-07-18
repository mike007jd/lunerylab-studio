"use client";

import {
  createContext,
  createElement,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  deriveCreativeCapabilityReadiness,
  type CreativeCapabilityReadiness,
  type CreativeReadinessProviderConnection,
} from "@/lib/client/creative-capability-readiness";
import { useModelCatalog } from "@/lib/client/use-model-catalog";
import { useSharedBootstrapSnapshot } from "@/lib/client/bootstrap-snapshot-provider";
import { useI18n } from "@/lib/i18n/provider";
import { isChineseLocale } from "@/lib/i18n/locale";
import { useT } from "@/lib/i18n/useT";
import { useDesktopLocalRuntimes } from "@/hooks/use-desktop-available";
import { useLocalModelSummary } from "@/hooks/use-local-model-summary";

const EMPTY_PROVIDER_CONNECTIONS: Record<string, CreativeReadinessProviderConnection> = {};
const CreativeCapabilityReadinessContext = createContext<CreativeCapabilityReadiness | null>(null);

function isTauriWebView(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
  );
}

function subscribeDesktopShellSnapshot(): () => void {
  return () => {};
}

function useCreativeCapabilityReadinessValue(): CreativeCapabilityReadiness {
  const t = useT();
  const { locale } = useI18n();
  const isDesktopShell = useSyncExternalStore(
    subscribeDesktopShellSnapshot,
    isTauriWebView,
    () => false,
  );
  const catalog = useModelCatalog();
  const bootstrap = useSharedBootstrapSnapshot();
  const localSummary = useLocalModelSummary();
  const localRuntimes = useDesktopLocalRuntimes();
  const providerConnections = bootstrap?.providerConnections ?? EMPTY_PROVIDER_CONNECTIONS;

  return useMemo(
    () =>
      deriveCreativeCapabilityReadiness({
        imageModels: catalog.imageModels,
        videoModels: catalog.videoModels,
        catalogLoading: catalog.loading,
        bootstrapDefaultImageModel: bootstrap?.app.defaultImageModel ?? "",
        providers: bootstrap?.providers ?? {},
        providerConnections,
        localSummary,
        localRuntimes,
        isDesktopShell,
        preferZh: isChineseLocale(locale),
        t,
      }),
    [
      bootstrap?.app.defaultImageModel,
      bootstrap?.providers,
      catalog.imageModels,
      catalog.loading,
      catalog.videoModels,
      isDesktopShell,
      localRuntimes,
      localSummary,
      locale,
      providerConnections,
      t,
    ],
  );
}

export function CreativeCapabilityReadinessProvider({ children }: { children: ReactNode }) {
  const readiness = useCreativeCapabilityReadinessValue();
  return createElement(CreativeCapabilityReadinessContext.Provider, { value: readiness }, children);
}

export function useCreativeCapabilityReadiness(): CreativeCapabilityReadiness {
  const readiness = useContext(CreativeCapabilityReadinessContext);
  if (!readiness) {
    throw new Error("useCreativeCapabilityReadiness must be used within its provider.");
  }
  return readiness;
}
