"use client";

import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { DESKTOP_WORKSPACE_RESET_CONFIRMATION } from "@/lib/desktop-workspace-reset";
import type { ErrorCopy } from "@/lib/i18n/error-copy";

export function WorkspaceResetRecovery({ copy }: { copy: ErrorCopy }) {
  const titleId = useId();
  const confirmationId = useId();
  const requestButtonRef = useRef<HTMLButtonElement>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [opening, setOpening] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);

  function beginConfirm() {
    setConfirming(true);
    queueMicrotask(() => confirmButtonRef.current?.focus());
  }

  function cancelConfirm() {
    setConfirming(false);
    setFailed(false);
    queueMicrotask(() => requestButtonRef.current?.focus());
  }

  async function resetWorkspace() {
    setPending(true);
    setFailed(false);
    try {
      const response = await fetch("/api/desktop-runtime/reset-workspace", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          confirmation: DESKTOP_WORKSPACE_RESET_CONFIRMATION,
        }),
      });
      if (!response.ok) throw new Error(`workspace reset failed (${response.status})`);
      // Keep pending=true: a 202 means the native runtime owns the reboot.
    } catch {
      setPending(false);
      setFailed(true);
      confirmButtonRef.current?.focus();
    }
  }

  async function openDataFolder() {
    setOpening(true);
    setOpenFailed(false);
    try {
      const response = await fetch("/api/desktop-runtime/open-profile-folder", { method: "POST" });
      if (!response.ok) throw new Error(`open profile failed (${response.status})`);
    } catch {
      setOpenFailed(true);
    } finally {
      setOpening(false);
    }
  }

  if (!confirming) {
    return (
      <div className="space-y-2 text-center">
        <div className="flex flex-wrap justify-center gap-2">
          <Button
            ref={requestButtonRef}
            type="button"
            onClick={beginConfirm}
            variant="destructive"
            aria-expanded={false}
            aria-controls={confirmationId}
          >
            {copy.resetWorkspace}
          </Button>
          <Button type="button" onClick={() => void openDataFolder()} variant="outline" loading={opening}>
            {opening ? copy.openingDataFolder : copy.openDataFolder}
          </Button>
        </div>
        {openFailed ? <p role="alert" className="text-sm text-destructive">{copy.openDataFolderFailed}</p> : null}
      </div>
    );
  }

  return (
    <div
      id={confirmationId}
      role="region"
      aria-labelledby={titleId}
      aria-busy={pending}
      className="basis-full max-w-md space-y-3 text-center"
    >
      <p id={titleId} className="text-sm text-(--text-secondary)">
        {copy.resetWorkspaceDescription}
      </p>
      {failed ? <p role="alert" className="text-sm text-destructive">{copy.resetWorkspaceFailed}</p> : null}
      <div className="flex flex-wrap justify-center gap-2">
        <Button
          ref={confirmButtonRef}
          type="button"
          variant="destructive"
          loading={pending}
          onClick={() => void resetWorkspace()}
        >
          {pending ? copy.resettingWorkspace : copy.confirmResetWorkspace}
        </Button>
        <Button type="button" variant="outline" disabled={pending} onClick={cancelConfirm}>
          {copy.cancel}
        </Button>
      </div>
    </div>
  );
}
