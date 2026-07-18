"use client";

import { useState } from "react";
import Link from "next/link";

import { AssetImage } from "@/components/ui/asset-image";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ArrowRight,
  Download,
  ExternalLink,
  Film,
  ImageIcon,
  MoreHorizontal,
  RotateCcw,
  Trash2,
} from "@/components/ui/icons";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useI18n } from "@/lib/i18n/provider";
import { useT } from "@/lib/i18n/useT";
import { extensionFromMime } from "@/lib/mime";
import { formatRelativeTime } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import type { ContentOrigin } from "@/lib/types/api";

const KIND_LABEL_KEYS: Record<string, string> = {
  REFERENCE: "assetActions.kindReference",
  GENERATED: "assetActions.kindGenerated",
};

interface AssetCardProps {
  id: string;
  url: string;
  kind: string;
  origin: ContentOrigin;
  mimeType: string;
  createdAt: string;
  prompt?: string | null;
  provider?: string | null;
  model?: string | null;
  projectName?: string | null;
  agentTaskId?: string | null;
  agentTaskSummary?: string | null;
  parentAssetId?: string | null;
  summary?: string | null;
  deletedAt?: string | null;
  onUseAsReference?: (assetId: string) => void;
  onOpenInCanvas?: (assetId: string) => void;
  openInCanvasPending?: boolean;
  openInCanvasDisabled?: boolean;
  openInCanvasError?: string | null;
  onGenerateVideo?: (assetId: string) => void;
  onDelete?: (assetId: string) => void;
  onRestore?: (assetId: string) => void;
  onPermanentDelete?: (assetId: string) => void;
  highlighted?: boolean;
  priority?: boolean;
}

// Shared by the "no image" branch and the AssetImage load-failure fallback so
// both render the same centered icon + label. Flat matte surface (no gradient)
// per the no-gradient DNA rule.
function renderMediaPlaceholder(text: string) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 bg-(--bg-elevated) px-4 text-center text-(--text-muted)">
      <span className="flex h-10 w-10 items-center justify-center rounded-full border border-(--border-subtle) bg-(--bg-surface)">
        <ImageIcon className="h-5 w-5 opacity-70" />
      </span>
      <span className="text-xs font-medium text-(--text-secondary)">{text}</span>
    </div>
  );
}

export function AssetCard({
  id,
  url,
  kind,
  origin,
  mimeType,
  createdAt,
  prompt,
  provider,
  model,
  projectName,
  agentTaskId,
  agentTaskSummary,
  parentAssetId,
  summary,
  deletedAt,
  onUseAsReference,
  onOpenInCanvas,
  openInCanvasPending = false,
  openInCanvasDisabled = false,
  openInCanvasError,
  onGenerateVideo,
  onDelete,
  onRestore,
  onPermanentDelete,
  highlighted = false,
  priority = false,
}: AssetCardProps) {
  const { locale } = useI18n();
  const t = useT();
  const [previewOpen, setPreviewOpen] = useState(false);
  const isTemplate = origin === "TEMPLATE";
  const labelKey = isTemplate ? "assetActions.kindTemplate" : KIND_LABEL_KEYS[kind];
  const kindLabel = labelKey ? t(labelKey) : kind;
  const isImage = mimeType.toLowerCase().startsWith("image/");
  const isVideo = mimeType.toLowerCase().startsWith("video/");
  const isDeleted = Boolean(deletedAt);
  const canUseAsReference = Boolean(onUseAsReference && isImage && !isDeleted);
  // Canvas layers are image shapes — video assets can't be placed on canvas.
  const canOpenInCanvas = Boolean(onOpenInCanvas && isImage && !isDeleted);
  const canGenerateVideo = Boolean(onGenerateVideo && isImage && !isDeleted);
  const promptText = isTemplate ? "" : prompt?.trim() ?? "";
  // Keep provider/model out of the dense card; the preview exposes them as
  // provenance for users who need to reproduce a result.
  const providerModel = isTemplate ? "" : [provider, model].filter(Boolean).join(" · ");
  const projectLabel = projectName?.trim() ?? "";
  const hasWorkflowMeta = Boolean(promptText || projectLabel);

  const handleDownload = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    const a = document.createElement("a");
    a.href = url;
    a.download = `asset-${id}.${extensionFromMime(mimeType)}`;
    a.click();
  };

  const handleOpenFullSize = () => {
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const handlePreviewKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    setPreviewOpen(true);
  };

  return (
    <div
      data-library-asset-id={id}
      className={cn(
        "group overflow-hidden rounded-lg border bg-(--bg-surface) transition-[border-color,box-shadow] duration-(--motion-control) hover:border-(--border-active) hover:shadow-(--shadow-sm)",
        highlighted
          ? "border-(--accent-glow) shadow-[0_0_0_2px_color-mix(in_oklab,var(--accent-glow)_34%,transparent)]"
          : "border-(--border-subtle)",
      )}
    >
      {/* Image area. The activation button covers the media but stays as a
          SIBLING of the overlay/action-menu so we don't nest interactive
          elements (HTML disallows buttons-in-buttons, and the dropdown
          trigger is itself a button). The activation button is the last
          element so the more-actions overlay receives clicks first when
          they overlap; everything else (video <controls>, dropdown
          trigger) is keyboard-reachable on its own. */}
      <div className="relative aspect-square w-full overflow-hidden bg-(--bg-elevated)">
        {isVideo ? (
          <video
            src={url}
            controls
            className="h-full w-full max-h-80 object-cover"
          />
        ) : isImage && url ? (
          // AssetImage renders a plain <img> (the private /api/assets/[id]
          // stream can't go through the next/image optimizer); its `fallback`
          // shows a tidy placeholder if the backing file was moved/deleted
          // (route 404s) instead of a broken-image glyph.
          <AssetImage
            src={url}
            alt={kindLabel}
            priority={priority}
            className="absolute inset-0 h-full w-full object-cover transition-transform duration-(--motion-control) group-hover:scale-105"
            fallback={renderMediaPlaceholder(t("assetActions.unavailable"))}
          />
        ) : (
          renderMediaPlaceholder(kind)
        )}

        {/* Activation button — absolutely positioned over the media. Excluded
            from the overlay coordinate space so the dropdown sits above it
            and receives its own clicks. Video uses native controls so the
            button overlay is rendered transparent over the player but only
            on non-video assets is `pointer-events` enabled. */}
        {!isVideo && (
          <Button
            type="button"
            variant="ghost"
            className="absolute inset-0 h-full min-h-0 w-full min-w-0 cursor-pointer rounded-none p-0 hover:bg-transparent active:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent-glow)"
            onClick={() => setPreviewOpen(true)}
            onKeyDown={handlePreviewKeyDown}
            aria-label={`${t("assetActions.preview")} — ${kindLabel}`}
          />
        )}

        {/* Hover overlay with action menu — sibling of the button, above it
            in z-order so it receives clicks instead of activation. */}
        <div className="pointer-events-none absolute inset-0 flex items-start justify-end gap-1 p-2 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:bg-(--scrim-hover) sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
          <div className="pointer-events-auto">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                onClick={(e) => e.stopPropagation()}
                aria-label={t("assetActions.more")}
                variant="ghost"
                size="icon-xs"
                className="size-9 rounded-md bg-(--scrim) p-1.5 text-(--text-primary) hover:bg-(--scrim-strong) sm:size-7"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-36">
              <DropdownMenuItem onClick={() => handleDownload()}>
                <Download className="h-4 w-4" />
                {t("assetActions.download")}
              </DropdownMenuItem>
              {canUseAsReference && (
                <DropdownMenuItem onClick={() => onUseAsReference?.(id)}>
                  <ImageIcon className="h-4 w-4" />
                  {t("assetActions.useAsReference")}
                </DropdownMenuItem>
              )}
              {canOpenInCanvas && (
                <DropdownMenuItem disabled={openInCanvasDisabled} onClick={() => onOpenInCanvas?.(id)}>
                  <ArrowRight className="h-4 w-4" />
                  {t("assetActions.openInCanvas")}
                </DropdownMenuItem>
              )}
              {canGenerateVideo && (
                <DropdownMenuItem onClick={() => onGenerateVideo?.(id)}>
                  <Film className="h-4 w-4" />
                  {t("assetActions.generateVideo")}
                </DropdownMenuItem>
              )}
              {onDelete && !isDeleted && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={() => onDelete(id)}>
                    <Trash2 className="h-4 w-4" />
                    {t("assetActions.delete")}
                  </DropdownMenuItem>
                </>
              )}
              {isDeleted && onRestore ? (
                <DropdownMenuItem onClick={() => onRestore(id)}>
                  <RotateCcw className="h-4 w-4" />
                  {t("assetActions.restore")}
                </DropdownMenuItem>
              ) : null}
              {isDeleted && onPermanentDelete ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={() => onPermanentDelete(id)}>
                    <Trash2 className="h-4 w-4" />
                    {t("assetActions.permanentDelete")}
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
          </div>
        </div>
      </div>

      {/* Workflow record */}
      <div className="space-y-2 p-2.5">
        <div className="flex items-center justify-between gap-1.5">
          <Badge variant="secondary" className="min-w-0 truncate px-1.5 py-0 text-xs">
            {isDeleted ? t("assetActions.inTrash") : kindLabel}
          </Badge>
          <span className="shrink-0 whitespace-nowrap text-xs text-(--text-muted)">
            {formatRelativeTime(createdAt, locale, t("assetActions.justNow"))}
          </span>
        </div>

        {hasWorkflowMeta ? (
          // Visible meta stays plain-language: prompt + project only. provider/model
          // ride along in the title tooltip for the curious, never on screen.
          <div className="space-y-1" title={providerModel || undefined}>
            {promptText ? (
              <p className="line-clamp-1 text-xs text-(--text-primary)">{promptText}</p>
            ) : null}
            {projectLabel ? (
              <p className="truncate text-xs text-(--text-muted)">{projectLabel}</p>
            ) : null}
          </div>
        ) : null}

      </div>

      {/* In-app preview — keeps inspection inside Studio instead of ejecting to
          a bare browser tab; the same actions live here, plus an explicit
          open-in-new-tab escape hatch. */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="text-sm">{kindLabel}</DialogTitle>
            <DialogDescription className="sr-only">
              {t("assetActions.previewDescription")}
            </DialogDescription>
          </DialogHeader>
          <div
            className="relative overflow-hidden rounded-lg border border-(--border-subtle) bg-(--bg-elevated)"
            style={{ maxHeight: "70vh" }}
          >
            {isVideo ? (
              <video src={url} controls className="w-full object-contain" style={{ maxHeight: "70vh" }} />
            ) : isImage && url ? (
              <AssetImage
                src={url}
                alt={kindLabel}
                priority
                className="w-full object-contain"
                style={{ maxHeight: "70vh" }}
                fallback={renderMediaPlaceholder(t("assetActions.unavailable"))}
              />
            ) : (
              renderMediaPlaceholder(kind)
            )}
          </div>
          <div className="grid gap-2 rounded-lg border border-(--border-subtle) bg-(--bg-surface) p-3 text-xs sm:grid-cols-2">
            <div>
              <p className="text-(--text-muted)">{t("assetActions.origin")}</p>
              <p className="mt-1 text-(--text-primary)">
                {isTemplate
                  ? t("assetActions.createdFromTemplate")
                  : agentTaskId
                    ? t("assetActions.createdByLuna")
                    : t("assetActions.createdInStudio")}
              </p>
              {agentTaskSummary ? <p className="mt-1 text-(--text-secondary)">{agentTaskSummary}</p> : null}
              {summary ? <p className="mt-1 text-(--text-secondary)">{summary}</p> : null}
            </div>
            <div>
              <p className="text-(--text-muted)">{t("assetActions.source")}</p>
              {isTemplate ? (
                <p className="mt-1 text-(--text-primary)">{t("assetActions.templateSource")}</p>
              ) : parentAssetId ? (
                <Button asChild variant="link" className="mt-1 h-auto p-0 text-xs">
                  <Link href={`/library?asset=${encodeURIComponent(parentAssetId)}`}>
                    {t("assetActions.derivedFromAsset")}
                  </Link>
                </Button>
              ) : (
                <p className="mt-1 text-(--text-primary)">{t("assetActions.originalAsset")}</p>
              )}
              {providerModel ? (
                <p className="mt-1 break-all text-(--text-muted)">{providerModel}</p>
              ) : null}
            </div>
          </div>
          {openInCanvasError ? (
            <p role="alert" className="text-sm text-destructive">
              {openInCanvasError}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => handleDownload()}>
              <Download className="h-4 w-4" />
              {t("assetActions.download")}
            </Button>
            {canUseAsReference && (
              <Button type="button" variant="ghost" size="sm" onClick={() => onUseAsReference?.(id)}>
                <ImageIcon className="h-4 w-4" />
                {t("assetActions.useAsReference")}
              </Button>
            )}
            {canOpenInCanvas && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                loading={openInCanvasPending}
                disabled={openInCanvasDisabled}
                onClick={() => onOpenInCanvas?.(id)}
              >
                <ArrowRight className="h-4 w-4" />
                {t("assetActions.openInCanvas")}
              </Button>
            )}
            {isDeleted && onRestore ? (
              <Button type="button" variant="secondary" size="sm" onClick={() => onRestore(id)}>
                <RotateCcw className="h-4 w-4" />
                {t("assetActions.restore")}
              </Button>
            ) : null}
            {isDeleted && onPermanentDelete ? (
              <Button type="button" variant="destructive" size="sm" onClick={() => onPermanentDelete(id)}>
                <Trash2 className="h-4 w-4" />
                {t("assetActions.permanentDelete")}
              </Button>
            ) : null}
            <Button type="button" variant="ghost" size="sm" onClick={handleOpenFullSize}>
              <ExternalLink className="h-4 w-4" />
              {t("assetActions.openInNewTab")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
