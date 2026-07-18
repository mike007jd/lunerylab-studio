import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchJson } from "@/lib/client/fetch-json";
import {
  clearPendingReferenceAsset,
  fetchPendingReference,
  readPendingReferenceAsset,
  shouldClearPendingReference,
} from "@/lib/client/reference-transfer";

export interface StudioReferencePreview {
  file: File;
  key: string;
  url: string;
}

function buildFileKey(file: File): string {
  return `${file.name}-${file.size}-${file.lastModified}`;
}

function mergeUniqueFiles(current: File[], incoming: File[], maxReferenceFiles: number): File[] {
  const seen = new Set<string>();
  const merged = [...current, ...incoming];
  const unique = merged.filter((file) => {
    const key = buildFileKey(file);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.slice(0, maxReferenceFiles);
}

function removeFileByKey(files: File[], targetKey: string): File[] {
  return files.filter((file) => buildFileKey(file) !== targetKey);
}

function reorderFilesByKey(files: File[], sourceKey: string, targetKey: string): File[] {
  const sourceIndex = files.findIndex((file) => buildFileKey(file) === sourceKey);
  const targetIndex = files.findIndex((file) => buildFileKey(file) === targetKey);
  if (sourceIndex === -1 || targetIndex === -1) {
    return files;
  }

  const next = [...files];
  const [item] = next.splice(sourceIndex, 1);
  next.splice(targetIndex, 0, item!); // safe: sourceIndex !== -1 guarded above, so splice removed one element
  return next;
}

function moveFileByKey(files: File[], key: string, direction: -1 | 1): File[] {
  const sourceIndex = files.findIndex((file) => buildFileKey(file) === key);
  const targetIndex = sourceIndex + direction;
  if (sourceIndex < 0 || targetIndex < 0 || targetIndex >= files.length) return files;

  const next = [...files];
  [next[sourceIndex], next[targetIndex]] = [next[targetIndex]!, next[sourceIndex]!];
  return next;
}

async function uploadReferenceAsset(file: File, projectId: string): Promise<string> {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("projectId", projectId);

  const payload = await fetchJson<{ asset: { id: string } }>("/api/assets/upload", {
    method: "POST",
    body: formData,
  });
  return payload.asset.id;
}

export function useStudioReferenceFiles(maxReferenceFiles: number) {
  const [files, setFiles] = useState<File[]>([]);
  const [draggingPreviewKey, setDraggingPreviewKey] = useState<string | null>(null);
  const [dragOverPreviewKey, setDragOverPreviewKey] = useState<string | null>(null);

  const filePreviews = useMemo<StudioReferencePreview[]>(
    () =>
      files.map((file) => ({
        file,
        key: buildFileKey(file),
        url: URL.createObjectURL(file),
      })),
    [files]
  );

  useEffect(
    () => () => {
      filePreviews.forEach((preview) => URL.revokeObjectURL(preview.url));
    },
    [filePreviews]
  );

  const handleFileChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const selected = Array.from(event.target.files ?? []);
      if (selected.length === 0) return;
      setFiles((prev) => mergeUniqueFiles(prev, selected, maxReferenceFiles));
      event.target.value = "";
    },
    [maxReferenceFiles]
  );

  const handleRemoveFile = useCallback((previewKey: string) => {
    setFiles((prev) => removeFileByKey(prev, previewKey));
  }, []);

  const handleMoveFile = useCallback((previewKey: string, direction: -1 | 1) => {
    setFiles((prev) => moveFileByKey(prev, previewKey, direction));
  }, []);

  const handlePreviewDragStart = useCallback((previewKey: string) => {
    setDraggingPreviewKey(previewKey);
  }, []);

  const handlePreviewDragEnd = useCallback(() => {
    setDraggingPreviewKey(null);
    setDragOverPreviewKey(null);
  }, []);

  const handlePreviewDragOver = useCallback(
    (event: React.DragEvent<HTMLElement>, previewKey: string) => {
      event.preventDefault();
      if (dragOverPreviewKey !== previewKey) {
        setDragOverPreviewKey(previewKey);
      }
    },
    [dragOverPreviewKey]
  );

  const handlePreviewDragLeave = useCallback(
    (previewKey: string) => {
      if (dragOverPreviewKey === previewKey) {
        setDragOverPreviewKey(null);
      }
    },
    [dragOverPreviewKey]
  );

  const handleDropOnPreview = useCallback(
    (targetPreviewKey: string) => {
      if (!draggingPreviewKey || draggingPreviewKey === targetPreviewKey) {
        setDragOverPreviewKey(null);
        return;
      }

      setFiles((prev) => reorderFilesByKey(prev, draggingPreviewKey, targetPreviewKey));
      setDragOverPreviewKey(null);
      setDraggingPreviewKey(null);
    },
    [draggingPreviewKey]
  );

  const uploadReferenceAssets = useCallback(
    async (projectId: string): Promise<string[]> => {
      if (!files.length) {
        return [];
      }

      const uploads = files.map((file) => uploadReferenceAsset(file, projectId));
      return Promise.all(uploads);
    },
    [files]
  );

  /**
   * Library "Use as reference" handshake. Library writes the asset id into
   * sessionStorage and navigates here; this method fetches the asset bytes,
   * materializes a File, and adds it through the same dedupe / cap path as
   * user-selected files. The key is consumed only after success or a permanent
   * invalid response, so aborts and transient failures can retry. Returns:
   *   - `null`  no pending key (no-op)
   *   - true    consumed successfully
   *   - false   key existed but fetch/conversion failed (caller may notify)
   */
  const consumePendingReference = useCallback(
    async (signal?: AbortSignal): Promise<boolean | null> => {
      const pendingAssetId = readPendingReferenceAsset();
      if (!pendingAssetId) return null;
      const result = await fetchPendingReference(pendingAssetId, signal);
      if (result.kind === "transient-failure") return false;
      if (result.kind === "permanent-failure") {
        if (shouldClearPendingReference(result)) clearPendingReferenceAsset();
        return false;
      }

      try {
        const file = new File(
          [result.blob],
          `library-ref-${pendingAssetId}.${result.extension}`,
          {
            type: result.contentType,
            lastModified: Date.now(),
          },
        );
        if (signal?.aborted) return false;
        setFiles((prev) => mergeUniqueFiles(prev, [file], maxReferenceFiles));
        if (shouldClearPendingReference(result)) clearPendingReferenceAsset();
        return true;
      } catch {
        // Materialization failures can be transient (for example, a browser
        // losing access during teardown), so preserve the handoff for retry.
        return false;
      }
    },
    [maxReferenceFiles],
  );

  return {
    files,
    filePreviews,
    draggingPreviewKey,
    dragOverPreviewKey,
    handleFileChange,
    handleRemoveFile,
    handleMoveFile,
    handlePreviewDragStart,
    handlePreviewDragEnd,
    handlePreviewDragOver,
    handlePreviewDragLeave,
    handleDropOnPreview,
    uploadReferenceAssets,
    consumePendingReference,
  };
}
