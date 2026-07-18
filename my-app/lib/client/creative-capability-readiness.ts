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
  providers: Record<string, ProviderSnapshot>;
  providerConnections: Record<string, CreativeReadinessProviderConnection>;
  localSummary: CreativeReadinessLocalSummary;
  localRuntimes: CreativeReadinessRuntime[] | null;
  isDesktopShell?: boolean;
  preferZh?: boolean;
  t: TFunction;
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

function providerWithModelRole(
  role: keyof ByokConnectionModels,
  providers: Record<string, ProviderSnapshot>,
  connections: Record<string, CreativeReadinessProviderConnection>,
) {
  return BYOK_PROVIDERS.find((provider) => {
    const modelId = connections[provider.id]?.models?.[role]?.trim();
    return Boolean(modelId && providerConfigured(providers, connections, provider.id));
  });
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
  providers,
  providerConnections,
  localSummary,
  localRuntimes,
  isDesktopShell = false,
  preferZh = false,
  t,
}: CreativeCapabilityReadinessInput): CreativeCapabilityReadiness {
  const runtimePreparing = Boolean(localRuntimes?.some(isRuntimePreparing));
  const textProvider = providerWithModelRole("text", providers, providerConnections);
  const videoProviderHasSecret = hasConfiguredProviderForCapability("video", providers, providerConnections);
  const imageProviderHasSecret = hasConfiguredProviderForCapability("image", providers, providerConnections);
  const textProviderHasSecret = hasConfiguredProviderForCapability("text", providers, providerConnections);
  const firstImageModel = imageModels[0];
  const firstVideoModel = videoModels[0];
  const activeImageLabel = localSummary.currentImageModel ?? imageModelLabel(firstImageModel, preferZh);
  const activeTextLabel =
    localSummary.currentTextModel ??
    (textProvider
      ? `${textProvider.label} · ${providerConnections[textProvider.id]?.models?.text}`
      : undefined);
  const activeVideoLabel = videoModelLabel(firstVideoModel, preferZh);
  const selectedDefault = imageModels.find(
    (model) =>
      model.id === bootstrapDefaultImageModel ||
      model.providerModelId === bootstrapDefaultImageModel,
  );
  const effectiveDefault = selectedDefault ?? (imageModels.length === 1 ? firstImageModel : undefined);

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
      : imageModels.length > 0
        ? {
            id: "imageGeneration",
            status: "ready",
            title: t("capabilityReadiness.image.readyTitle"),
            detail: activeImageLabel
              ? t("capabilityReadiness.image.readyDetailWithModel", { model: activeImageLabel })
              : t("capabilityReadiness.image.readyDetail"),
            shortLabel: t("capabilityReadiness.sidebar.ready"),
            activeLabel: activeImageLabel,
            href: "/settings?panel=local-models",
            actionLabel: t("capabilityReadiness.actions.manageModels"),
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
              href: imageProviderHasSecret ? "/settings?panel=provider-connections" : "/settings?panel=local-models",
              actionLabel: imageProviderHasSecret
                ? t("capabilityReadiness.actions.selectProviderModel")
                : t("capabilityReadiness.actions.installImageModel"),
            }
  );

  const promptRefinement: CreativeCapabilityItem = (
    localSummary.hasReadyText || textProvider
      ? {
          id: "promptRefinement",
          status: "ready",
          title: t("capabilityReadiness.prompt.readyTitle"),
          detail: activeTextLabel
            ? t("capabilityReadiness.prompt.readyDetailWithModel", { model: activeTextLabel })
            : t("capabilityReadiness.prompt.readyDetail"),
          shortLabel: t("capabilityReadiness.sidebar.ready"),
          activeLabel: activeTextLabel,
          href: "/settings?panel=local-models",
          actionLabel: t("capabilityReadiness.actions.manageModels"),
        }
      : {
          id: "promptRefinement",
          status: "partial",
          title: textProviderHasSecret
            ? t("capabilityReadiness.prompt.modelMissingTitle")
            : t("capabilityReadiness.prompt.missingTitle"),
          detail: textProviderHasSecret
            ? t("capabilityReadiness.prompt.modelMissingDetail")
            : t("capabilityReadiness.prompt.missingDetail"),
          shortLabel: textProviderHasSecret
            ? t("capabilityReadiness.sidebar.textModelMissing")
            : t("capabilityReadiness.sidebar.textMissing"),
          reason: textProviderHasSecret
            ? t("capabilityReadiness.prompt.modelMissingReason")
            : t("capabilityReadiness.prompt.missingReason"),
          href: textProviderHasSecret ? "/settings?panel=provider-connections" : "/settings?panel=local-models",
          actionLabel: textProviderHasSecret
            ? t("capabilityReadiness.actions.selectTextModel")
            : t("capabilityReadiness.actions.installTextModel"),
        }
  );

  const videoGeneration: CreativeCapabilityItem = (
    videoModels.length > 0
      ? {
          id: "videoGeneration",
          status: "ready",
          title: t("capabilityReadiness.video.readyTitle"),
          detail: activeVideoLabel
            ? t("capabilityReadiness.video.readyDetailWithModel", { model: activeVideoLabel })
            : t("capabilityReadiness.video.readyDetail"),
          shortLabel: t("capabilityReadiness.sidebar.ready"),
          activeLabel: activeVideoLabel,
          href: "/settings?panel=provider-connections",
          actionLabel: t("capabilityReadiness.actions.manageProviders"),
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
          href: "/settings?panel=provider-connections",
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
          href: "/settings?panel=general",
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
            href: "/settings?panel=general",
            actionLabel: t("capabilityReadiness.actions.selectDefault"),
          }
        : {
            id: "defaults",
            status: "missing",
            title: t("capabilityReadiness.defaults.noModelTitle"),
            detail: t("capabilityReadiness.defaults.noModelDetail"),
            shortLabel: t("capabilityReadiness.sidebar.defaultMissing"),
            reason: t("capabilityReadiness.defaults.noModelReason"),
            href: "/settings?panel=local-models",
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
