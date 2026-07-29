import { BYOK_PROVIDERS, type ByokConnectionModels } from "@/lib/byok-providers";
import type { ImageModelEntry } from "@/lib/image-models";
import type { TFunction } from "@/lib/i18n/provider";
import type { ProviderSnapshot } from "@/lib/client/use-bootstrap-snapshot";
import type { VideoModelEntry } from "@/lib/video-models";
import { PUBLIC_SITE_DOWNLOAD_URL } from "@/lib/public-site";

export type CreativeCapabilityId =
  | "runtime"
  | "imageGeneration"
  | "promptRefinement"
  | "videoGeneration"
  | "defaults";

export type CreativeCapabilityStatus =
  | "ready"
  | "partial"
  | "missing"
  | "preparing"
  | "checking";

export interface CreativeCapabilityItem {
  id: CreativeCapabilityId;
  status: CreativeCapabilityStatus;
  title: string;
  detail: string;
  shortLabel: string;
  activeLabel?: string;
  reason?: string;
  href?: string;
  actionLabel?: string;
}

export interface CreativeCapabilityReadiness {
  overallStatus: CreativeCapabilityStatus;
  title: string;
  detail: string;
  summaryLabel: string;
  primaryIssue: CreativeCapabilityItem | null;
  items: CreativeCapabilityItem[];
  byId: Record<CreativeCapabilityId, CreativeCapabilityItem>;
  readyCount: number;
  totalCount: number;
}

export interface CreativeReadinessLocalSummary {
  desktop: boolean | null;
  currentTextModel: string | null;
  currentTextModelId?: string | null;
  currentImageModel: string | null;
  hasReadyText: boolean;
  hasReadyImage: boolean;
}

export interface CreativeReadinessRuntime {
  id: string;
  status: string;
  label?: string;
}

export interface CreativeReadinessProviderConnection {
  models?: ByokConnectionModels;
  hasSecret?: boolean;
}

export interface CreativeCapabilityReadinessInput {
  imageModels: ImageModelEntry[];
  videoModels: VideoModelEntry[];
  catalogLoading: boolean;
  bootstrapDefaultImageModel?: string | null;
  bootstrapDefaultTextModel?: string | null;
  bootstrapDefaultVideoModel?: string | null;
  providers: Record<string, ProviderSnapshot>;
  providerConnections: Record<string, CreativeReadinessProviderConnection>;
  localSummary: CreativeReadinessLocalSummary;
  localRuntimes: CreativeReadinessRuntime[] | null;
  isDesktopShell?: boolean;
  preferZh?: boolean;
  t: TFunction;
}

const BYOK_TEXT_SELECTION = /^byok:([^:]+):(.+)$/;

function normalizeLocalTextModelId(value: string): string {
  return value.trim().toLowerCase().replace(/:latest$/, "");
}

function parseExplicitByokTextSelection(
  value: string,
): { providerId: string; modelId: string } | null {
  const match = BYOK_TEXT_SELECTION.exec(value.trim());
  if (!match) return null;
  const providerId = match[1]?.trim() ?? "";
  const modelId = match[2]?.trim() ?? "";
  if (!providerId || !modelId) return null;
  return { providerId, modelId };
}

function resolveExplicitTextReadiness({
  bootstrapDefaultTextModel,
  providers,
  providerConnections,
  localSummary,
}: {
  bootstrapDefaultTextModel?: string | null;
  providers: Record<string, ProviderSnapshot>;
  providerConnections: Record<string, CreativeReadinessProviderConnection>;
  localSummary: CreativeReadinessLocalSummary;
}): { ready: boolean; activeLabel?: string } {
  const selected = bootstrapDefaultTextModel?.trim() ?? "";
  if (!selected) return { ready: false };

  if (selected.startsWith("local:")) {
    const modelId = selected.slice("local:".length).trim();
    if (!modelId || !localSummary.hasReadyText) return { ready: false };
    const currentModelId = localSummary.currentTextModelId?.trim() ?? "";
    // Exact normalized id only. The visible label is not an authority and
    // suffix matching could make a different model look selected.
    if (
      !currentModelId ||
      normalizeLocalTextModelId(currentModelId) !== normalizeLocalTextModelId(modelId)
    ) {
      return { ready: false };
    }
    return {
      ready: true,
      activeLabel: localSummary.currentTextModel?.trim() || currentModelId,
    };
  }

  const byok = parseExplicitByokTextSelection(selected);
  if (!byok) return { ready: false };
  if (!providerConfigured(providers, providerConnections, byok.providerId)) {
    return { ready: false };
  }
  const slot = providerConnections[byok.providerId]?.models?.text?.trim();
  if (slot !== byok.modelId) return { ready: false };
  const provider = BYOK_PROVIDERS.find((entry) => entry.id === byok.providerId);
  return {
    ready: true,
    activeLabel: provider ? `${provider.label} · ${byok.modelId}` : byok.modelId,
  };
}

const ISSUE_ORDER: CreativeCapabilityId[] = [
  "runtime",
  "imageGeneration",
  "defaults",
];

function isRuntimePreparing(runtime: CreativeReadinessRuntime): boolean {
  return runtime.status === "starting" || runtime.status === "downloading";
}

function imageModelLabel(model: ImageModelEntry | undefined, preferZh: boolean): string | undefined {
  if (!model) return undefined;
  return preferZh ? model.labelZh : model.label;
}

function videoModelLabel(model: VideoModelEntry | undefined, preferZh: boolean): string | undefined {
  if (!model) return undefined;
  return preferZh ? model.labelZh : model.label;
}

function providerConfigured(
  providers: Record<string, ProviderSnapshot>,
  connections: Record<string, CreativeReadinessProviderConnection>,
  providerId: string,
): boolean {
  return providers[providerId]?.configured === true || connections[providerId]?.hasSecret === true;
}

function hasConfiguredProviderForCapability(
  capability: "text" | "image" | "video",
  providers: Record<string, ProviderSnapshot>,
  connections: Record<string, CreativeReadinessProviderConnection>,
): boolean {
  return BYOK_PROVIDERS.some((provider) => {
    const supports =
      capability === "text"
        ? provider.capabilities.includes("text")
        : capability === "image"
          ? provider.capabilities.includes("image") && provider.imageApiMode !== "none"
          : Boolean(provider.videoApiMode && provider.videoApiMode !== "none");
    return supports && providerConfigured(providers, connections, provider.id);
  });
}

function itemMap(items: CreativeCapabilityItem[]): Record<CreativeCapabilityId, CreativeCapabilityItem> {
  return Object.fromEntries(items.map((item) => [item.id, item])) as Record<
    CreativeCapabilityId,
    CreativeCapabilityItem
  >;
}

function isReady(item: CreativeCapabilityItem): boolean {
  return item.status === "ready";
}

export function deriveCreativeCapabilityReadiness({
  imageModels,
  videoModels,
  catalogLoading,
  bootstrapDefaultImageModel,
  bootstrapDefaultTextModel,
  bootstrapDefaultVideoModel,
  providers,
  providerConnections,
  localSummary,
  localRuntimes,
  isDesktopShell = false,
  preferZh = false,
  t,
}: CreativeCapabilityReadinessInput): CreativeCapabilityReadiness {
  const runtimePreparing = Boolean(localRuntimes?.some(isRuntimePreparing));
  const videoProviderHasSecret = hasConfiguredProviderForCapability("video", providers, providerConnections);
  const imageProviderHasSecret = hasConfiguredProviderForCapability("image", providers, providerConnections);
  const textProviderHasSecret = hasConfiguredProviderForCapability("text", providers, providerConnections);
  const explicitText = resolveExplicitTextReadiness({
    bootstrapDefaultTextModel,
    providers,
    providerConnections,
    localSummary,
  });
  const activeTextLabel = explicitText.activeLabel;
  // Explicit video default only — a non-empty catalog with an empty/invalid
  // default is partial and must not label the first catalog entry as active.
  const selectedVideoModel = videoModels.find(
    (model) =>
      model.id === bootstrapDefaultVideoModel ||
      model.providerModelId === bootstrapDefaultVideoModel,
  );
  const activeVideoLabel = videoModelLabel(selectedVideoModel, preferZh);
  // Explicit selection only: a ready local image model without a saved default
  // is NOT a usable default. Nothing may silently substitute a model the user
  // never picked, so there is no single-model implicit default here.
  const selectedDefault = imageModels.find(
    (model) =>
      model.id === bootstrapDefaultImageModel ||
      model.providerModelId === bootstrapDefaultImageModel,
  );
  const effectiveDefault = selectedDefault;
  const defaultImageLabel =
    imageModelLabel(effectiveDefault, preferZh) ?? effectiveDefault?.id;
  // Prefer the resolved explicit default label. Keep a currently-running local
  // model label only when it corresponds to that same resolved default.
  const runningMatchesDefault = Boolean(
    effectiveDefault &&
      localSummary.currentImageModel &&
      (localSummary.currentImageModel === defaultImageLabel ||
        localSummary.currentImageModel === effectiveDefault.id ||
        localSummary.currentImageModel === effectiveDefault.providerModelId ||
        localSummary.currentImageModel === effectiveDefault.label ||
        localSummary.currentImageModel === effectiveDefault.labelZh),
  );
  const activeImageLabel = runningMatchesDefault
    ? localSummary.currentImageModel!
    : defaultImageLabel;

  const runtime: CreativeCapabilityItem = (
    localSummary.desktop === null
      ? {
          id: "runtime",
          status: "checking",
          title: t("capabilityReadiness.runtime.checkingTitle"),
          detail: t("capabilityReadiness.runtime.checkingDetail"),
          shortLabel: t("capabilityReadiness.sidebar.checking"),
        }
      : localSummary.desktop === true
        ? {
            id: "runtime",
            status: runtimePreparing ? "preparing" : "ready",
            title: runtimePreparing
              ? t("capabilityReadiness.runtime.preparingTitle")
              : t("capabilityReadiness.runtime.readyTitle"),
            detail: runtimePreparing
              ? t("capabilityReadiness.runtime.preparingDetail")
              : t("capabilityReadiness.runtime.readyDetail"),
            shortLabel: runtimePreparing
              ? t("capabilityReadiness.sidebar.preparing")
              : t("capabilityReadiness.sidebar.ready"),
            activeLabel: t("capabilityReadiness.runtime.activeDesktop"),
            href: "/settings?panel=runtime-diagnostics",
            actionLabel: t("capabilityReadiness.actions.diagnoseRuntime"),
          }
        : {
            id: "runtime",
            status: "missing",
            title: t("capabilityReadiness.runtime.missingTitle"),
            detail: isDesktopShell
              ? t("capabilityReadiness.runtime.missingShellDetail")
              : t("capabilityReadiness.runtime.missingDetail"),
            shortLabel: t("capabilityReadiness.sidebar.runtimeMissing"),
            reason: isDesktopShell
              ? t("capabilityReadiness.runtime.missingShellReason")
              : t("capabilityReadiness.runtime.missingReason"),
            href: isDesktopShell
              ? "/settings?panel=runtime-diagnostics"
              : PUBLIC_SITE_DOWNLOAD_URL,
            actionLabel: isDesktopShell
              ? t("capabilityReadiness.actions.diagnoseRuntime")
              : t("capabilityReadiness.actions.getDesktop"),
          }
  );

  const imageGeneration: CreativeCapabilityItem = (
    catalogLoading
      ? {
          id: "imageGeneration",
          status: "checking",
          title: t("capabilityReadiness.image.checkingTitle"),
          detail: t("capabilityReadiness.image.checkingDetail"),
          shortLabel: t("capabilityReadiness.sidebar.checking"),
        }
      : imageModels.length > 0 && effectiveDefault
        ? {
            id: "imageGeneration",
            status: "ready",
            title: t("capabilityReadiness.image.readyTitle"),
            detail: activeImageLabel
              ? t("capabilityReadiness.image.readyDetailWithModel", { model: activeImageLabel })
              : t("capabilityReadiness.image.readyDetail"),
            shortLabel: t("capabilityReadiness.sidebar.ready"),
            activeLabel: activeImageLabel,
            href: "/settings?panel=image",
            actionLabel: t("capabilityReadiness.actions.manageModels"),
          }
        : imageModels.length > 0
          ? {
              // Models exist but none was explicitly chosen as the default.
              // Not ready: generation must never silently dispatch to an
              // unchosen model, so the visible banner routes to Image settings.
              id: "imageGeneration",
              status: "partial",
              title: t("capabilityReadiness.defaults.missingTitle"),
              detail: t("capabilityReadiness.defaults.missingDetail"),
              shortLabel: t("capabilityReadiness.sidebar.defaultMissing"),
              reason: t("capabilityReadiness.defaults.missingReason"),
              href: "/settings?panel=image",
              actionLabel: t("capabilityReadiness.actions.openImageSettings"),
            }
          : runtimePreparing
          ? {
              id: "imageGeneration",
              status: "preparing",
              title: t("capabilityReadiness.image.preparingTitle"),
              detail: t("capabilityReadiness.image.preparingDetail"),
              shortLabel: t("capabilityReadiness.sidebar.imagePreparing"),
              href: "/settings?panel=local-models",
              actionLabel: t("capabilityReadiness.actions.openModels"),
            }
          : {
              id: "imageGeneration",
              status: "missing",
              title: imageProviderHasSecret
                ? t("capabilityReadiness.image.modelMissingTitle")
                : t("capabilityReadiness.image.missingTitle"),
              detail: imageProviderHasSecret
                ? t("capabilityReadiness.image.modelMissingDetail")
                : t("capabilityReadiness.image.missingDetail"),
              shortLabel: imageProviderHasSecret
                ? t("capabilityReadiness.sidebar.imageModelMissing")
                : t("capabilityReadiness.sidebar.imageMissing"),
              reason: imageProviderHasSecret
                ? t("capabilityReadiness.image.modelMissingReason")
                : t("capabilityReadiness.image.missingReason"),
              href: imageProviderHasSecret ? "/settings?panel=image" : "/settings?panel=local-models",
              actionLabel: imageProviderHasSecret
                ? t("capabilityReadiness.actions.selectProviderModel")
                : t("capabilityReadiness.actions.installImageModel"),
            }
  );

  const promptRefinement: CreativeCapabilityItem = (
    explicitText.ready
      ? {
          id: "promptRefinement",
          status: "ready",
          title: t("capabilityReadiness.prompt.readyTitle"),
          detail: activeTextLabel
            ? t("capabilityReadiness.prompt.readyDetailWithModel", { model: activeTextLabel })
            : t("capabilityReadiness.prompt.readyDetail"),
          shortLabel: t("capabilityReadiness.sidebar.ready"),
          activeLabel: activeTextLabel,
          href: "/settings?panel=text",
          actionLabel: t("capabilityReadiness.actions.manageModels"),
        }
      : {
          id: "promptRefinement",
          status: "partial",
          title: textProviderHasSecret || localSummary.hasReadyText
            ? t("capabilityReadiness.prompt.modelMissingTitle")
            : t("capabilityReadiness.prompt.missingTitle"),
          detail: textProviderHasSecret || localSummary.hasReadyText
            ? t("capabilityReadiness.prompt.modelMissingDetail")
            : t("capabilityReadiness.prompt.missingDetail"),
          shortLabel: textProviderHasSecret || localSummary.hasReadyText
            ? t("capabilityReadiness.sidebar.textModelMissing")
            : t("capabilityReadiness.sidebar.textMissing"),
          reason: textProviderHasSecret || localSummary.hasReadyText
            ? t("capabilityReadiness.prompt.modelMissingReason")
            : t("capabilityReadiness.prompt.missingReason"),
          // Text capability fixes always land on the Text settings tab — the
          // default text model picker and local text models live there.
          href: "/settings?panel=text",
          actionLabel: textProviderHasSecret || localSummary.hasReadyText
            ? t("capabilityReadiness.actions.selectTextModel")
            : t("capabilityReadiness.actions.installTextModel"),
        }
  );

  const videoGeneration: CreativeCapabilityItem = (
    selectedVideoModel
      ? {
          id: "videoGeneration",
          status: "ready",
          title: t("capabilityReadiness.video.readyTitle"),
          detail: activeVideoLabel
            ? t("capabilityReadiness.video.readyDetailWithModel", { model: activeVideoLabel })
            : t("capabilityReadiness.video.readyDetail"),
          shortLabel: t("capabilityReadiness.sidebar.ready"),
          activeLabel: activeVideoLabel,
          href: "/settings?panel=video",
          actionLabel: t("capabilityReadiness.actions.manageProviders"),
        }
      : videoModels.length > 0
        ? {
            id: "videoGeneration",
            status: "partial",
            title: t("capabilityReadiness.video.modelMissingTitle"),
            detail: t("capabilityReadiness.video.modelMissingDetail"),
            shortLabel: t("capabilityReadiness.sidebar.videoModelMissing"),
            reason: t("capabilityReadiness.video.modelMissingReason"),
            href: "/settings?panel=video",
            actionLabel: t("capabilityReadiness.actions.selectVideoModel"),
          }
      : {
          id: "videoGeneration",
          status: "partial",
          title: videoProviderHasSecret
            ? t("capabilityReadiness.video.modelMissingTitle")
            : t("capabilityReadiness.video.missingTitle"),
          detail: videoProviderHasSecret
            ? t("capabilityReadiness.video.modelMissingDetail")
            : t("capabilityReadiness.video.missingDetail"),
          shortLabel: videoProviderHasSecret
            ? t("capabilityReadiness.sidebar.videoModelMissing")
            : t("capabilityReadiness.sidebar.videoMissing"),
          reason: videoProviderHasSecret
            ? t("capabilityReadiness.video.modelMissingReason")
            : t("capabilityReadiness.video.missingReason"),
          href: "/settings?panel=video",
          actionLabel: videoProviderHasSecret
            ? t("capabilityReadiness.actions.selectVideoModel")
            : t("capabilityReadiness.actions.connectVideoProvider"),
        }
  );

  const defaults: CreativeCapabilityItem = (
    effectiveDefault
      ? {
          id: "defaults",
          status: "ready",
          title: t("capabilityReadiness.defaults.readyTitle"),
          detail: t("capabilityReadiness.defaults.readyDetailWithModel", {
            model: imageModelLabel(effectiveDefault, preferZh) ?? effectiveDefault.id,
          }),
          shortLabel: t("capabilityReadiness.sidebar.ready"),
          activeLabel: imageModelLabel(effectiveDefault, preferZh) ?? effectiveDefault.id,
          href: "/settings?panel=image",
          actionLabel: t("capabilityReadiness.actions.changeDefault"),
        }
      : imageModels.length > 0
        ? {
            id: "defaults",
            status: "partial",
            title: t("capabilityReadiness.defaults.missingTitle"),
            detail: t("capabilityReadiness.defaults.missingDetail"),
            shortLabel: t("capabilityReadiness.sidebar.defaultMissing"),
            reason: t("capabilityReadiness.defaults.missingReason"),
            href: "/settings?panel=image",
            actionLabel: t("capabilityReadiness.actions.selectDefault"),
          }
        : {
            id: "defaults",
            status: "missing",
            title: t("capabilityReadiness.defaults.noModelTitle"),
            detail: t("capabilityReadiness.defaults.noModelDetail"),
            shortLabel: t("capabilityReadiness.sidebar.defaultMissing"),
            reason: t("capabilityReadiness.defaults.noModelReason"),
            href: "/settings?panel=image",
            actionLabel: t("capabilityReadiness.actions.installImageModel"),
          }
  );

  const items = [runtime, imageGeneration, promptRefinement, videoGeneration, defaults];
  const byId = itemMap(items);
  const primaryIssue =
    ISSUE_ORDER.map((id) => byId[id]).find((item) => !isReady(item)) ?? null;
  const overallStatus: CreativeCapabilityStatus = !primaryIssue
    ? "ready"
    : primaryIssue.status;
  const readyCount = items.filter(isReady).length;

  return {
    overallStatus,
    title: t("capabilityReadiness.title"),
    detail: t(`capabilityReadiness.overall.${overallStatus}`),
    summaryLabel:
      overallStatus === "ready"
        ? t("capabilityReadiness.sidebar.ready")
        : primaryIssue?.shortLabel ?? t("capabilityReadiness.sidebar.checking"),
    primaryIssue,
    items,
    byId,
    readyCount,
    totalCount: items.length,
  };
}
