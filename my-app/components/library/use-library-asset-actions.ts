"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchJson, toErrorMessage } from "@/lib/client/fetch-json";
import { sendAssetToCanvas } from "@/lib/client/canvas-sessions";
import { storePendingReferenceAsset } from "@/lib/client/reference-transfer";
import { useTemporaryMessage } from "@/hooks/use-temporary-message";
import { useT } from "@/lib/i18n/useT";
import { addCanvasEntrySource } from "@/lib/client/creation-flow";
import type { LibraryAsset } from "@/components/library/library-asset-tabs";

interface UseLibraryAssetActionsOptions {
  /** Drop the asset from the caller's own list after a successful delete. */
  onAssetDeleted: (assetId: string) => void;
  /** Reinsert a recovered asset into the caller's active list. */
  onAssetRestored: (asset: LibraryAsset) => void;
  /** Scope new canvas sessions to a project when the surface is project-bound. */
  projectId?: string;
}

/** Shared asset-row actions for the Library all-view and the per-project
 * workspace — use-as-reference, open-in-canvas, and delete — plus the transient
 * notice/error + delete-dialog state they both render. Lives in one place so the
 * two surfaces can't drift. The caller owns its own asset list; error setter is
 * exposed so a host with extra actions (e.g. session delete) can share the same
 * error surface. */
export function useLibraryAssetActions({
  onAssetDeleted,
  onAssetRestored,
  projectId,
}: UseLibraryAssetActionsOptions) {
  const t = useT();
  const router = useRouter();
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [pendingDeleteAssetId, setPendingDeleteAssetId] = useState<string | null>(null);
  const [deletingAsset, setDeletingAsset] = useState(false);
  const [restoringAssetId, setRestoringAssetId] = useState<string | null>(null);
  const [pendingPermanentDeleteAssetId, setPendingPermanentDeleteAssetId] = useState<string | null>(null);
  const [permanentlyDeletingAsset, setPermanentlyDeletingAsset] = useState(false);
  const openingCanvasAssetRef = useRef(false);
  const [openingCanvasAssetId, setOpeningCanvasAssetId] = useState<string | null>(null);
  const [canvasActionError, setCanvasActionError] = useState<{
    assetId: string;
    message: string;
  } | null>(null);

  useTemporaryMessage(notice, () => setNotice(""), 1600);

  const handleUseAsReference = (assetId: string) => {
    if (!storePendingReferenceAsset(assetId)) {
      setError(t("studio.libraryTabs.useAsReferenceFailed"));
      return;
    }
    setNotice(t("studio.libraryTabs.useAsReferenceSent"));
    router.push("/studio");
  };

  const handleOpenInCanvas = async (assetId: string) => {
    if (openingCanvasAssetRef.current) return;
    openingCanvasAssetRef.current = true;
    setOpeningCanvasAssetId(assetId);
    setCanvasActionError(null);
    setError("");
    try {
      const { url } = await sendAssetToCanvas({
        assetId,
        title: t("studio.canvasTitle"),
        projectId: projectId || undefined,
      });
      router.push(
        addCanvasEntrySource(url, projectId ? `project:${projectId}` : "library"),
      );
    } catch (requestError) {
      const message = toErrorMessage(requestError, t("studio.canvasCreateFailed"));
      setCanvasActionError({ assetId, message });
      setError(message);
    } finally {
      openingCanvasAssetRef.current = false;
      setOpeningCanvasAssetId(null);
    }
  };

  const handleConfirmDeleteAsset = async () => {
    if (!pendingDeleteAssetId) return;
    try {
      setDeletingAsset(true);
      await fetchJson(`/api/assets/${pendingDeleteAssetId}`, { method: "DELETE" });
      onAssetDeleted(pendingDeleteAssetId);
    } catch (requestError) {
      setError(toErrorMessage(requestError, t("library.deleteAssetFailed")));
    } finally {
      setDeletingAsset(false);
      setPendingDeleteAssetId(null);
    }
  };

  const handleRestoreAsset = async (assetId: string) => {
    if (restoringAssetId) return;
    try {
      setRestoringAssetId(assetId);
      await fetchJson(`/api/assets/${assetId}`, {
        method: "PATCH",
        body: JSON.stringify({ restore: true }),
      });
      const params = new URLSearchParams({ assetId, limit: "1" });
      if (projectId) params.set("projectId", projectId);
      const page = await fetchJson<{ assets: LibraryAsset[] }>(
        `/api/library/search?${params.toString()}`,
        { cache: "no-store" },
      );
      const restored = page.assets[0];
      if (restored) onAssetRestored(restored);
      setNotice(t("library.assetRestored"));
    } catch (requestError) {
      setError(toErrorMessage(requestError, t("library.restoreAssetFailed")));
    } finally {
      setRestoringAssetId(null);
    }
  };

  const handleConfirmPermanentDeleteAsset = async () => {
    if (!pendingPermanentDeleteAssetId) return;
    try {
      setPermanentlyDeletingAsset(true);
      await fetchJson(`/api/assets/${pendingPermanentDeleteAssetId}?permanent=true`, { method: "DELETE" });
      onAssetDeleted(pendingPermanentDeleteAssetId);
    } catch (requestError) {
      setError(toErrorMessage(requestError, t("library.permanentDeleteAssetFailed")));
    } finally {
      setPermanentlyDeletingAsset(false);
      setPendingPermanentDeleteAssetId(null);
    }
  };

  return {
    notice,
    error,
    setError,
    pendingDeleteAssetId,
    setPendingDeleteAssetId,
    deletingAsset,
    restoringAssetId,
    pendingPermanentDeleteAssetId,
    setPendingPermanentDeleteAssetId,
    permanentlyDeletingAsset,
    openingCanvasAssetId,
    canvasActionError,
    handleUseAsReference,
    handleOpenInCanvas,
    handleConfirmDeleteAsset,
    handleRestoreAsset,
    handleConfirmPermanentDeleteAsset,
  };
}
