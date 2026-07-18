import { Button } from "@/components/ui/button";
import { FolderOpen } from "@/components/ui/icons";
import { Skeleton } from "@/components/ui/skeleton";
import type { RuntimeProbeResult } from "@/lib/desktop-runtime";
import { PanelEmpty, RuntimeBadge, type RuntimeBadgeState } from "./badges";
import type { COPY } from "./constants";
import type { DesktopBridgePhase, DesktopRuntimeStatus, ProviderFeedback } from "./types";

type Copy = (typeof COPY)[keyof typeof COPY];

export function RuntimePanels({
  status,
  bridgePhase,
  unavailable,
  runtimeProbes,
  copy,
  profileFeedback,
  openingProfileFolder = false,
  onOpenProfileFolder,
}: {
  status: DesktopRuntimeStatus | null;
  bridgePhase: DesktopBridgePhase;
  unavailable: boolean;
  runtimeProbes: Record<string, RuntimeProbeResult | null>;
  copy: Copy;
  profileFeedback?: ProviderFeedback | null;
  openingProfileFolder?: boolean;
  onOpenProfileFolder?: () => void;
}) {
  return (
    <div className="grid min-w-0 gap-4">
      <div className="min-w-0">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-xs font-semibold text-(--text-secondary)">
              {copy.profileTitle}
            </h3>
            {status === null ? bridgePhase === "loading" ? (
              <Skeleton className="mt-2 h-3 w-48 bg-(--bg-glass)" />
            ) : (
              <p className="mt-1 text-xs text-(--text-muted)">{copy.profileEmptyText}</p>
            ) : (
              <p className="mt-1 truncate text-xs text-(--text-muted)" title={status.profile_root}>
                {status.profile_root}
              </p>
            )}
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghostMuted"
            className="shrink-0"
            disabled={!status || unavailable || openingProfileFolder}
            onClick={onOpenProfileFolder}
          >
            <FolderOpen className="h-3.5 w-3.5" />
            {openingProfileFolder ? copy.openingProfileFolder : copy.openProfileFolder}
          </Button>
        </div>
        {profileFeedback ? (
          <p className={
            profileFeedback.tone === "error"
              ? "mt-2 text-xs text-(--destructive)"
              : profileFeedback.tone === "success"
                ? "mt-2 text-xs text-(--success)"
                : "mt-2 text-xs text-(--text-muted)"
          }>
            {profileFeedback.text}
          </p>
        ) : null}
      </div>

      <div className="min-w-0 border-t border-(--border-subtle) pt-4">
        <h3 className="mb-3 text-xs font-semibold text-(--text-secondary)">
          {copy.runtimeTitle}
        </h3>
        <div className="space-y-2">
          {status === null ? (
            unavailable ? (
              <PanelEmpty title={copy.runtimeEmptyTitle} text={copy.runtimeEmptyText} />
            ) : (
              [0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-12 rounded-xl bg-(--bg-glass)" />
              ))
            )
          ) : status.local_runtimes.length === 0 ? (
            <PanelEmpty title={copy.runtimeEmptyTitle} text={copy.runtimeEmptyText} />
          ) : (
            <div className="divide-y divide-(--border-subtle)">
              {status.local_runtimes.map((runtime) => {
                const probe = runtimeProbes[runtime.id];
                let badgeLabel: string;
                let badgeState: RuntimeBadgeState;
                if (probe === undefined) {
                  badgeLabel = copy.runtimeProbing;
                  badgeState = "checking";
                } else if (probe === null || !probe.reachable) {
                  badgeLabel = copy.notConnected;
                  badgeState = "unreachable";
                } else {
                  const count = probe.models.length;
                  badgeLabel = count > 0
                    ? `${copy.runtimeAvailable} · ${count} ${copy.runtimeModels}`
                    : copy.runtimeAvailable;
                  badgeState = "ready";
                }
                return (
                  <div key={runtime.id} className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium text-(--text-primary)">{runtime.label}</p>
                      <p className="truncate text-xs text-(--text-muted)">{runtime.endpoint}</p>
                    </div>
                    <RuntimeBadge state={badgeState}>{badgeLabel}</RuntimeBadge>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="min-w-0 border-t border-(--border-subtle) pt-4">
        <h3 className="mb-3 text-xs font-semibold text-(--text-secondary)">
          {copy.modelStoreTitle}
        </h3>
        <div className="space-y-2">
          {status === null && bridgePhase === "loading" ? (
            [0, 1].map((i) => (
              <Skeleton key={i} className="h-12 rounded-xl bg-(--bg-glass)" />
            ))
          ) : status === null || status.model_stores.length === 0 ? (
            <PanelEmpty title={copy.modelStoreEmptyTitle} text={copy.modelStoreEmptyText} />
          ) : (
            <div className="divide-y divide-(--border-subtle)">
              {status.model_stores.map((store) => (
                <div key={store.id} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium text-(--text-primary)">{store.label}</p>
                    <p className="truncate text-xs text-(--text-muted)">{store.path}</p>
                  </div>
                  <RuntimeBadge state={store.available ? "ready" : "missing"}>
                    {store.available ? copy.available : copy.missing}
                  </RuntimeBadge>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
