import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AdvancedDisclosure } from "@/components/ui/advanced-disclosure";
import { ConfirmActionDialog } from "@/components/ui/confirm-action-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ExternalLink, Lock, MoreHorizontal, ShieldCheck, Trash2 } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import { formatProviderCapabilities } from "@/lib/provider-capabilities";
import {
  byokModelInputRoles,
  type ByokConnectionModels,
  type ByokModelRole,
  type ByokProviderMeta,
} from "@/lib/byok-providers";
import type { COPY } from "./constants";
import type {
  DesktopBridgePhase,
  ProviderFeedback,
  ProviderView,
  SavedProviderConnection,
} from "./types";
import { shouldOpenProviderAdvancedSettings } from "./utils";

type Copy = (typeof COPY)[keyof typeof COPY];

const ROLE_LABEL_KEY: Record<ByokModelRole, keyof Copy> = {
  text: "modelRoleText",
  imageGenerate: "modelRoleImage",
  imageEdit: "modelRoleImage",
  video: "modelRoleVideo",
  model3d: "modelRole3d",
};

export function ProviderConnectionsPanel({
  providers,
  activeMeta,
  draftProvider,
  draftEndpoint,
  draftModels,
  draftKey,
  connections,
  activeProviderHasSecret,
  bridgePhase,
  unavailable,
  feedback,
  testing,
  testCooldown,
  saving,
  canTestConnection,
  invokeCommand,
  saveDisabledReason,
  testDisabledReason,
  copy,
  visibleRoles,
  onSelectProvider,
  onDraftEndpointChange,
  onDraftModelChange,
  onDraftKeyChange,
  onRemoveProvider,
  onTestConnection,
  onSaveProvider,
}: {
  providers: ProviderView[];
  activeMeta: ByokProviderMeta;
  draftProvider: string;
  draftEndpoint: string;
  draftModels: ByokConnectionModels;
  draftKey: string;
  connections: Record<string, SavedProviderConnection>;
  activeProviderHasSecret: boolean;
  bridgePhase: DesktopBridgePhase;
  unavailable: boolean;
  feedback: ProviderFeedback | null;
  testing: boolean;
  testCooldown: boolean;
  saving: boolean;
  canTestConnection: boolean;
  invokeCommand: unknown;
  saveDisabledReason: string | undefined;
  testDisabledReason: string | undefined;
  copy: Copy;
  visibleRoles?: ByokModelRole[];
  onSelectProvider: (providerId: string) => void;
  onDraftEndpointChange: (value: string) => void;
  onDraftModelChange: (role: ByokModelRole, value: string) => void;
  onDraftKeyChange: (value: string) => void;
  onRemoveProvider: (providerId: string) => Promise<boolean>;
  onTestConnection: () => void;
  onSaveProvider: () => void;
}) {
  const [providerPendingRemoval, setProviderPendingRemoval] = useState<string | null>(null);
  const [providerRemovalPending, setProviderRemovalPending] = useState(false);
  const inputRoles = visibleRoles ?? byokModelInputRoles(activeMeta);
  // A single-slot provider keeps its helpful catalog example as the placeholder;
  // for multi-slot providers an image example in the text field would mislead,
  // so fall back to a generic hint.
  const modelPlaceholder =
    inputRoles.length === 1 ? activeMeta.placeholderModelId ?? copy.modelIdHint : copy.modelIdHint;
  const hasAnyModel = inputRoles.some((role) => draftModels[role]?.trim());

  // Durable secret state for the active provider — distinct from the transient
  // save/test feedback line. A key persisted in the keychain (or supplied by
  // the environment) should stay visible on the field, not vanish after the
  // toast.
  const activeProvider = providers.find((provider) => provider.id === draftProvider);
  const secretFromEnv = activeProvider?.source === copy.env;
  const showStoredSecret = activeProviderHasSecret && !draftKey.trim();

  return (
    <div id="provider-connections" className="min-w-0 scroll-mt-24">
      <div className="mb-3 flex flex-col items-start gap-2 sm:flex-row sm:justify-between sm:gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-(--text-primary)">
            {copy.providerTitle}
          </h2>
          <p className="mt-1 text-xs text-(--text-muted)">{copy.providerSubtitle}</p>
        </div>
        <Badge variant="outline" className="max-w-full shrink whitespace-normal text-left">
          <Lock className="h-3 w-3" />
          {copy.locked}
        </Badge>
      </div>

      {unavailable ? (
        <div className="mb-3 flex items-start gap-2 rounded-lg bg-(--warning-soft) px-3 py-2 text-xs text-(--warning)">
          <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            <span className="font-semibold">{copy.bridgeDownTitle}</span>
            <span className="mt-0.5 block text-(--text-secondary)">{copy.bridgeDownText}</span>
          </span>
        </div>
      ) : null}

      <div className="min-w-0 space-y-3">
        <label className="block max-w-sm space-y-1.5 text-xs font-medium text-(--text-secondary)">
          {copy.providerLabel}
          <Select value={draftProvider} onValueChange={onSelectProvider}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {providers.map((provider) => (
                <SelectItem key={provider.id} value={provider.id}>
                  {provider.label}{provider.configured ? ` · ${copy.saved}` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="block font-normal text-(--text-muted)">
            {formatProviderCapabilities(activeMeta, copy)}
            {activeProvider?.configured ? ` · ${activeProvider.source}` : ""}
          </span>
        </label>

        <div className="min-w-0 space-y-3">
          {/* Calm default: connecting a cloud key is just "paste API key".
              Server address + model ID + source detail are power-user controls
              collapsed under Advanced settings so a non-expert isn't asked to
              fill fields they don't understand. */}
          <label className="block space-y-1.5 text-xs font-medium text-(--text-secondary)">
            {copy.key}
            <Input
              type="password"
              value={draftKey}
              placeholder={activeProviderHasSecret ? "••••••••••••" : copy.keyPlaceholder}
              onChange={(event) => onDraftKeyChange(event.target.value)}
            />
            {showStoredSecret ? (
              <span className="flex items-center gap-1.5 font-normal text-(--success)">
                <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
                {secretFromEnv ? copy.secretStoredEnv : copy.secretStored}
              </span>
            ) : null}
          </label>

          <AdvancedDisclosure
            title={copy.advancedTitle}
            // A required model id is part of the primary connection contract,
            // not a power-user option. Keep Advanced open until every required
            // field is visible; this product never invents a default model.
            defaultOpen={shouldOpenProviderAdvancedSettings(activeMeta)}
          >
            <div className="grid gap-2 sm:grid-cols-2">
              {activeMeta.requiresEndpoint && (
                <label className="space-y-1.5 text-xs font-medium text-(--text-secondary)">
                  {copy.endpoint}
                  <Input
                    value={draftEndpoint}
                    onChange={(event) => onDraftEndpointChange(event.target.value)}
                    placeholder={activeMeta.defaultEndpoint}
                  />
                </label>
              )}
              {inputRoles.map((role) => (
                <label
                  key={role}
                  className="space-y-1.5 text-xs font-medium text-(--text-secondary)"
                >
                  {inputRoles.length > 1 ? copy[ROLE_LABEL_KEY[role]] : copy.modelId}
                  <Input
                    value={draftModels[role] ?? ""}
                    onChange={(event) => onDraftModelChange(role, event.target.value)}
                    placeholder={modelPlaceholder}
                  />
                </label>
              ))}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-(--border-subtle) pt-3 text-xs leading-5 text-(--text-muted)">
              <span>{copy.modelIdHint}</span>
              <a
                href={activeMeta.sourceEvidence.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 font-medium text-(--text-secondary) underline-offset-2 hover:text-(--text-primary) hover:underline"
              >
                {copy.openModelList}
                <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              </a>
            </div>
          </AdvancedDisclosure>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p
              role="status"
              aria-live="polite"
              className={cn(
                "min-w-0 flex-1 text-xs",
                feedback?.tone === "error"
                  ? "text-destructive"
                  : feedback?.tone === "success"
                    ? "text-(--success)"
                    : "text-(--text-muted)",
              )}
            >
              {feedback?.text ?? (bridgePhase === "loading"
                ? copy.bridgeChecking
                : providers.find((provider) => provider.id === draftProvider)?.source)}
            </p>
            <div className="grid shrink-0 grid-cols-[auto_1fr] gap-2 sm:flex sm:justify-end">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghostMuted"
                    size="icon-sm"
                    aria-label={secretFromEnv ? copy.managedByEnvironment : copy.moreActions}
                    title={secretFromEnv ? copy.managedByEnvironment : undefined}
                    disabled={
                      secretFromEnv ||
                      providerRemovalPending ||
                      !invokeCommand ||
                      (!connections[draftProvider] && !activeProviderHasSecret)
                    }
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => setProviderPendingRemoval(draftProvider)}
                  >
                    <Trash2 className="h-4 w-4" />
                    {copy.remove}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                type="button"
                variant="ghostMuted"
                size="sm"
                className="justify-center"
                onClick={() => onTestConnection()}
                title={testDisabledReason}
                disabled={!canTestConnection || testing || testCooldown}
              >
                {testing ? copy.testing : copy.test}
              </Button>
              <Button
                type="button"
                size="sm"
                className="col-span-2 justify-center sm:col-span-1"
                onClick={() => onSaveProvider()}
                title={saveDisabledReason}
                loading={saving}
                disabled={
                  saving ||
                  (!draftKey.trim() && !activeProviderHasSecret) ||
                  !invokeCommand ||
                  (activeMeta.requiresEndpoint && !draftEndpoint.trim()) ||
                  (activeMeta.requiresModelId && !hasAnyModel)
                }
              >
                {copy.save}
              </Button>
            </div>
          </div>
        </div>
      </div>
      <ConfirmActionDialog
        open={providerPendingRemoval !== null}
        onOpenChange={(open) => {
          if (!open && !providerRemovalPending) setProviderPendingRemoval(null);
        }}
        title={copy.removeConfirmTitle}
        description={copy.removeConfirmDescription}
        confirmLabel={copy.remove}
        cancelLabel={copy.cancel}
        pending={providerRemovalPending}
        onConfirm={async () => {
          if (!providerPendingRemoval) return;
          setProviderRemovalPending(true);
          try {
            await onRemoveProvider(providerPendingRemoval);
            // Close on both success and failure so the persistent inline status
            // behind the modal is visible and the user can recover immediately.
            setProviderPendingRemoval(null);
          } finally {
            setProviderRemovalPending(false);
          }
        }}
      />
    </div>
  );
}
