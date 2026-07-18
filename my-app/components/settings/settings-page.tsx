"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { motion } from "framer-motion";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Activity, Bot, Film, ImageIcon, Settings } from "@/components/ui/icons";
import {
  HoverLiftCard,
  PageReveal,
  useMotionReducedPreference,
} from "@/components/motion/motion-primitives";
import { lunaMotion } from "@/components/design-system/grammar/motion";
import { fetchJson, toErrorMessage } from "@/lib/client/fetch-json";
import { resolveSelectableImageModelId, useModelCatalog } from "@/lib/client/use-model-catalog";
import { useI18n } from "@/lib/i18n/provider";
import { useT } from "@/lib/i18n/useT";
import { cn } from "@/lib/utils";
import type { Locale } from "@/lib/i18n/locale";
import {
  BOOTSTRAP_INVALIDATION_EVENT,
  fetchBootstrapSnapshot,
  type BootstrapSnapshot,
} from "@/lib/client/use-bootstrap-snapshot";
import { DesktopRuntimeCard } from "./desktop-runtime-card";
import { LocalModelsPanel } from "./local-models-panel";
import { RuntimeHealthPanel } from "./runtime-health-panel";
import { SettingsDefaultModelCard } from "./settings-default-model-card";
import { SettingsCapabilityDefaultCard } from "./settings-capability-default-card";
import { SettingsLanguageCard } from "./settings-language-card";
import { WorkspaceDataPanel } from "./workspace-data-panel";

type SettingsTab = "text" | "image" | "video" | "general" | "status";

// A tab query update can rebuild this client boundary. Keep only the clicked
// target long enough for that rebuilt panel to run its tab-only entrance.
let pendingAnimatedSettingsTab: SettingsTab | null = null;

const TAB_ORDER: { id: SettingsTab; icon: typeof Bot }[] = [
  { id: "text", icon: Bot },
  { id: "image", icon: ImageIcon },
  { id: "video", icon: Film },
  { id: "general", icon: Settings },
  { id: "status", icon: Activity },
];

// Deep links (?panel=…) and the cross-panel "Diagnose" action route to the
// matching tab.
const PANEL_TO_TAB: Record<string, SettingsTab> = {
  "local-models": "image",
  "provider-connections": "image",
  text: "text",
  image: "image",
  video: "video",
  general: "general",
  "runtime-diagnostics": "status",
};

const TAB_TO_PANEL: Record<SettingsTab, string> = {
  text: "text",
  image: "image",
  video: "video",
  general: "general",
  status: "runtime-diagnostics",
};

function resolveTab(panel: string | null, capability: string | null): SettingsTab {
  if (capability === "text" || capability === "image" || capability === "video") return capability;
  if (panel && PANEL_TO_TAB[panel]) return PANEL_TO_TAB[panel];
  return "text";
}

export function shouldMountSettingsTab(
  mountedTabs: ReadonlySet<SettingsTab>,
  activeTab: SettingsTab,
  tab: SettingsTab,
): boolean {
  return activeTab === tab || mountedTabs.has(tab);
}

export function retainSettingsTabs(
  current: ReadonlySet<SettingsTab>,
  ...tabs: SettingsTab[]
): Set<SettingsTab> {
  const next = new Set(current);
  for (const tab of tabs) next.add(tab);
  return next;
}

export function resolveSettingsModelValue(persisted: string, draft: string | null): string {
  return draft ?? persisted;
}

// Keeps its panel mounted (so tab switches don't refetch / lose local state)
// while hiding the inactive ones. `animate` keys off `active` so the enter fade
// replays each time the tab becomes visible — without ever changing the child
// tree's position (which would remount and defeat the point).
function TabPanel({
  active,
  animateEntry,
  reduced,
  tab,
  children,
}: {
  active: boolean;
  animateEntry: boolean;
  reduced: boolean;
  tab: SettingsTab;
  children: ReactNode;
}) {
  useEffect(() => {
    if (active && reduced && pendingAnimatedSettingsTab === tab) {
      pendingAnimatedSettingsTab = null;
    }
  }, [active, reduced, tab]);

  return (
    <motion.div
      hidden={!active}
      aria-hidden={!active}
      initial={animateEntry && !reduced ? { opacity: 0, y: 6 } : false}
      animate={!active || reduced || !animateEntry ? undefined : { opacity: [0, 1], y: [6, 0] }}
      transition={reduced ? undefined : lunaMotion.overlay}
      onAnimationComplete={() => {
        if (pendingAnimatedSettingsTab === tab) pendingAnimatedSettingsTab = null;
      }}
      className="space-y-5"
    >
      {children}
    </motion.div>
  );
}

export function SettingsPage({
  initialData,
}: {
  initialData: BootstrapSnapshot;
}) {
  const { locale, setLocale } = useI18n();
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const t = useT();
  const reduced = useMotionReducedPreference();
  const { imageModels, videoModels, loading: modelsLoading } = useModelCatalog();
  const [bootstrap, setBootstrap] = useState(initialData);
  const [defaultModel, setDefaultModel] = useState(
    initialData.app.defaultImageModel || "",
  );
  const [defaultTextModelDraft, setDefaultTextModelDraft] = useState<string | null>(null);
  const [defaultVideoModelDraft, setDefaultVideoModelDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [localeError, setLocaleError] = useState("");

  // URL is the single source of truth for the active tab.
  // Derived on every render — no setState required.
  const activeTab = resolveTab(searchParams.get("panel"), searchParams.get("capability"));
  const [mountedTabs, setMountedTabs] = useState<Set<SettingsTab>>(
    () => new Set([activeTab]),
  );

  useEffect(() => {
    let active = true;
    const syncBootstrap = async () => {
      const next = await fetchBootstrapSnapshot();
      if (active && next) setBootstrap(next);
    };
    window.addEventListener(BOOTSTRAP_INVALIDATION_EVENT, syncBootstrap);
    return () => {
      active = false;
      window.removeEventListener(BOOTSTRAP_INVALIDATION_EVENT, syncBootstrap);
    };
  }, []);

  // Navigate to a tab by pushing the matching ?panel= value.
  function navigateToTab(tab: SettingsTab) {
    pendingAnimatedSettingsTab = tab;
    setMountedTabs((current) => {
      if (current.has(activeTab) && current.has(tab)) return current;
      return retainSettingsTabs(current, activeTab, tab);
    });
    const returnTo = searchParams.get("returnTo");
    const suffix = returnTo ? `&returnTo=${encodeURIComponent(returnTo)}` : "";
    router.replace(`${pathname}?panel=${TAB_TO_PANEL[tab]}&capability=${tab}${suffix}`, { scroll: false });
  }

  // The language card highlights the LIVE UI locale (what the user is seeing
  // right now), not the persisted server default — otherwise a seeded default
  // of "en" would keep "English" checked while the UI renders in Chinese.
  const selectedLocale = locale as Locale;
  const selectableDefaultModel = resolveSelectableImageModelId(imageModels, defaultModel, "");
  const persistedDefaultModel = resolveSelectableImageModelId(
    imageModels,
    bootstrap.app.defaultImageModel,
    "",
  );
  const modelChanged = selectableDefaultModel !== persistedDefaultModel;
  const saveDisabled = saving || modelsLoading || !modelChanged;
  const defaultTextModel = resolveSettingsModelValue(
    bootstrap.app.defaultTextModel,
    defaultTextModelDraft,
  );
  const defaultVideoModel = resolveSettingsModelValue(
    bootstrap.app.defaultVideoModel,
    defaultVideoModelDraft,
  );

  const textOptions = useMemo(() => {
    const options = Object.entries(bootstrap.providerConnections).flatMap(([providerId, connection]) => {
      const modelId = connection.models?.text?.trim();
      if (!modelId || bootstrap.providers[providerId]?.configured !== true) return [];
      return [{ id: `byok:${providerId}:${modelId}`, label: `${providerId} — ${modelId}` }];
    });
    if (bootstrap.app.defaultTextModel.startsWith("local:")) {
      options.unshift({
        id: bootstrap.app.defaultTextModel,
        label: `Local — ${bootstrap.app.defaultTextModel.slice("local:".length)}`,
      });
    }
    return options;
  }, [bootstrap.app.defaultTextModel, bootstrap.providerConnections, bootstrap.providers]);
  const videoOptions = useMemo(() => videoModels.map((model) => ({
    id: model.id,
    label: `${model.brand} — ${model.label}`,
  })), [videoModels]);

  async function patchSettings(payload: {
    defaultLocale?: Locale;
    defaultTextModel?: string;
    defaultImageModel?: string;
    defaultVideoModel?: string;
  }) {
    const response = await fetchJson<{
      app: BootstrapSnapshot["app"];
      providers: BootstrapSnapshot["providers"];
    }>("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    setBootstrap((current) => ({ ...current, app: response.app, providers: response.providers }));
  }

  useEffect(() => {
    const returnTo = searchParams.get("returnTo");
    const capability = searchParams.get("capability");
    if (!returnTo?.startsWith("/canvas/")) return;
    const ready = capability === "text"
      ? Boolean(bootstrap.app.defaultTextModel)
      : capability === "image"
        ? Boolean(bootstrap.app.defaultImageModel)
        : capability === "video"
          ? Boolean(bootstrap.app.defaultVideoModel)
          : false;
    if (ready) router.replace(returnTo);
  }, [bootstrap.app.defaultImageModel, bootstrap.app.defaultTextModel, bootstrap.app.defaultVideoModel, router, searchParams]);

  async function handleLocaleChange(nextLocale: Locale) {
    setLocaleError("");
    setLocale(nextLocale);
    setBootstrap((current) => ({ ...current, app: { ...current.app, defaultLocale: nextLocale } }));
    try {
      await patchSettings({ defaultLocale: nextLocale });
    } catch {
      // Surface the failure on the Language card itself, not the Model card.
      setLocaleError(t("settings.saveError"));
    }
  }

  async function handleSaveModel() {
    setSaving(true);
    setFeedback(null);
    try {
      await patchSettings({ defaultImageModel: selectableDefaultModel });
      setFeedback({ tone: "success", text: t("settings.saved") });
    } catch (error) {
      setFeedback({ tone: "error", text: toErrorMessage(error, t("settings.saveError")) });
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveCapabilityDefault(capability: "text" | "video") {
    setSaving(true);
    setFeedback(null);
    try {
      await patchSettings(capability === "text"
        ? { defaultTextModel }
        : { defaultVideoModel });
      if (capability === "text") setDefaultTextModelDraft(null);
      else setDefaultVideoModelDraft(null);
      setFeedback({ tone: "success", text: t("settings.saved") });
    } catch (error) {
      setFeedback({ tone: "error", text: toErrorMessage(error, t("settings.saveError")) });
    } finally {
      setSaving(false);
    }
  }

  const tabs = useMemo(
    () => TAB_ORDER.map((tab) => ({ ...tab, label: t(`settings.tabs.${tab.id}`) })),
    [t],
  );

  return (
    <PageReveal className="w-full">
      <Tabs
        value={activeTab}
        onValueChange={(value) => navigateToTab(value as SettingsTab)}
        className="w-full space-y-5"
      >
      {/* Segmented tab rail — replaces the page-title card; the breadcrumb in the
          top header already names this surface. */}
      <TabsList
        aria-label={t("settings.sectionsLabel")}
        className="-mx-1 flex h-auto w-[calc(100%+0.5rem)] flex-nowrap items-center justify-start gap-1 overflow-x-auto bg-transparent px-1 pb-1 sm:mx-0 sm:w-full sm:gap-1.5 sm:overflow-visible sm:p-0"
      >
        {tabs.map(({ id, icon: Icon, label }) => {
          const isActive = activeTab === id;
          return (
            <TabsTrigger
              key={id}
              value={id}
              className={cn(
                "h-8 shrink-0 gap-1 rounded-lg px-2 text-[11px] sm:gap-1.5 sm:px-3 sm:text-xs",
                isActive && "shadow-(--shadow-sm)",
                id === "status" && "ml-auto text-(--text-muted)",
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </TabsTrigger>
          );
        })}
      </TabsList>

      {/* Retain creative panels so drafts survive tab changes. Diagnostics has
          no drafts, so it mounts only while active and stops background probes
          as soon as the user leaves the status tab. */}
      <div className="space-y-5">
        <TabsContent value="text" forceMount hidden={activeTab !== "text"}>
          <TabPanel
            active={activeTab === "text"}
            animateEntry={pendingAnimatedSettingsTab === "text"}
            reduced={reduced}
            tab="text"
          >
            {shouldMountSettingsTab(mountedTabs, activeTab, "text") ? (
              <div className="space-y-5">
                <SettingsCapabilityDefaultCard
                  capability="text"
                  value={defaultTextModel}
                  options={textOptions}
                  saving={saving}
                  changed={defaultTextModel !== bootstrap.app.defaultTextModel}
                  feedback={feedback}
                  onChange={setDefaultTextModelDraft}
                  onSave={() => void handleSaveCapabilityDefault("text")}
                />
                <LocalModelsPanel capability="text" />
                <DesktopRuntimeCard capability="text" />
              </div>
            ) : null}
          </TabPanel>
        </TabsContent>

        <TabsContent value="image" forceMount hidden={activeTab !== "image"}>
          <TabPanel
            active={activeTab === "image"}
            animateEntry={pendingAnimatedSettingsTab === "image"}
            reduced={reduced}
            tab="image"
          >
            {shouldMountSettingsTab(mountedTabs, activeTab, "image") ? (
              <div className="space-y-5">
                <SettingsDefaultModelCard
                  defaultModel={selectableDefaultModel}
                  disabled={saveDisabled}
                  feedback={feedback}
                  locale={selectedLocale}
                  models={imageModels}
                  onModelChange={setDefaultModel}
                  onSave={() => void handleSaveModel()}
                  saving={saving}
                />
                <LocalModelsPanel capability="image" />
                <DesktopRuntimeCard capability="image" />
              </div>
            ) : null}
          </TabPanel>
        </TabsContent>

        <TabsContent value="video" forceMount hidden={activeTab !== "video"}>
          <TabPanel
            active={activeTab === "video"}
            animateEntry={pendingAnimatedSettingsTab === "video"}
            reduced={reduced}
            tab="video"
          >
            {shouldMountSettingsTab(mountedTabs, activeTab, "video") ? (
              <div className="space-y-5">
                <SettingsCapabilityDefaultCard
                  capability="video"
                  value={defaultVideoModel}
                  options={videoOptions}
                  saving={saving}
                  changed={defaultVideoModel !== bootstrap.app.defaultVideoModel}
                  feedback={feedback}
                  onChange={setDefaultVideoModelDraft}
                  onSave={() => void handleSaveCapabilityDefault("video")}
                />
                <DesktopRuntimeCard capability="video" />
              </div>
            ) : null}
          </TabPanel>
        </TabsContent>

        <TabsContent value="general" forceMount hidden={activeTab !== "general"}>
          <TabPanel
            active={activeTab === "general"}
            animateEntry={pendingAnimatedSettingsTab === "general"}
            reduced={reduced}
            tab="general"
          >
            {shouldMountSettingsTab(mountedTabs, activeTab, "general") ? (
              <div className="grid gap-5 lg:grid-cols-2">
                <HoverLiftCard>
                  <SettingsLanguageCard locale={selectedLocale} onLocaleChange={handleLocaleChange} error={localeError} />
                </HoverLiftCard>
                <WorkspaceDataPanel />
              </div>
            ) : null}
          </TabPanel>
        </TabsContent>

        <TabsContent value="status" forceMount hidden={activeTab !== "status"}>
          <TabPanel
            active={activeTab === "status"}
            animateEntry={pendingAnimatedSettingsTab === "status"}
            reduced={reduced}
            tab="status"
          >
            {activeTab === "status" ? (
              <div id="runtime-diagnostics" className="scroll-mt-24">
                <RuntimeHealthPanel />
              </div>
            ) : null}
          </TabPanel>
        </TabsContent>
      </div>
      </Tabs>
    </PageReveal>
  );
}
