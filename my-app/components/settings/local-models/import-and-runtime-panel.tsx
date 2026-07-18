"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Download, RefreshCw, Zap } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import type { ExternalRuntimeModel, RuntimeInstallEntry, RuntimeTargetOption } from "./types";
import type { CopyShape } from "./copy";

export function ImportAndRuntimePanel({
  copy,
  externalRuntimes,
  runtimeInstallList,
  importStatus,
  runtimeTarget,
  hfUrl,
  localPath,
  probing,
  importing,
  onRuntimeTargetChange,
  onHfUrlChange,
  onLocalPathChange,
  onImportPath,
  onImportUrl,
  onProbeRuntimes,
  onLaunchRuntime,
}: {
  copy: CopyShape;
  externalRuntimes: ExternalRuntimeModel[];
  runtimeInstallList: RuntimeInstallEntry[];
  importStatus: { tone: "success" | "error"; text: string } | null;
  runtimeTarget: RuntimeTargetOption;
  hfUrl: string;
  localPath: string;
  probing: boolean;
  importing: boolean;
  onRuntimeTargetChange: (target: RuntimeTargetOption) => void;
  onHfUrlChange: (value: string) => void;
  onLocalPathChange: (value: string) => void;
  onImportPath: () => void;
  onImportUrl: () => void;
  onProbeRuntimes: () => void;
  onLaunchRuntime: (id: string) => void;
}) {
  const importFileHint =
    runtimeTarget === "sd-cpp" || runtimeTarget === "comfyui"
      ? "model.safetensors"
      : "model.gguf";

  return (
    <div className="grid gap-3 border-t border-(--border-subtle) pt-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(260px,0.8fr)]">
      <div>
        <div className="mb-3">
          <h3 className="text-xs font-semibold text-(--text-secondary)">
            {copy.importTitle}
          </h3>
        </div>

        {/* Runtime target is chosen once and applies to both import methods
            below, so it gets its own row instead of competing with the URL
            field — that also lets the two import inputs share one edge. */}
        <div className="mb-3 text-xs text-(--text-muted)">
          <span id="local-model-import-runtime-label">{copy.importRuntimeLabel}</span>
          <Select
            value={runtimeTarget}
            onValueChange={(value) => onRuntimeTargetChange(value as RuntimeTargetOption)}
          >
            <SelectTrigger
              aria-labelledby="local-model-import-runtime-label"
              className="mt-1 h-9 w-full border-(--border-subtle) bg-(--bg-elevated) text-xs text-(--text-primary) sm:max-w-[260px]"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="llama-cpp">Text model</SelectItem>
              <SelectItem value="sd-cpp">Image model</SelectItem>
              <SelectItem value="ollama">Ollama</SelectItem>
              <SelectItem value="lm-studio">LM Studio</SelectItem>
              <SelectItem value="comfyui">ComfyUI</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Both import methods share one grid: each input fills the first
            column (so the two fields share left/right edges) and the two
            actions stack into a single right-hand column at equal width. */}
        <div className="grid gap-x-2 gap-y-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <div className="text-xs text-(--text-muted)">
            <span id="local-model-import-url-label">{copy.importUrlLabel}</span>
            <Input
              aria-labelledby="local-model-import-url-label"
              value={hfUrl}
              onChange={(event) => onHfUrlChange(event.target.value)}
              placeholder={`https://huggingface.co/.../resolve/main/${importFileHint}`}
              className="mt-1"
            />
          </div>
          <Button
            type="button"
            size="sm"
            width="full"
            className="justify-center"
            disabled={importing || hfUrl.trim().length === 0}
            onClick={onImportUrl}
          >
            <Download className="h-3 w-3" />
            {copy.actionQueueUrl}
          </Button>

          <label className="text-xs text-(--text-muted)">
            {copy.importFileLabel}
            <Input
              value={localPath}
              onChange={(event) => onLocalPathChange(event.target.value)}
              placeholder={`/Users/me/Models/${importFileHint}`}
              className="mt-1"
            />
          </label>
          <Button
            type="button"
            size="sm"
            width="full"
            className="justify-center"
            disabled={importing || localPath.trim().length === 0}
            onClick={onImportPath}
          >
            <Download className="h-3 w-3" />
            {copy.actionImportFile}
          </Button>
        </div>

        {importStatus && (
          <p
            className={cn(
              "mt-2 text-xs",
              importStatus.tone === "error" ? "text-(--destructive)" : "text-(--success)",
            )}
          >
            {importStatus.text}
          </p>
        )}
      </div>

      <div>
        <div className="mb-3 flex items-start justify-between gap-2">
          <div>
            <h3 className="text-xs font-semibold text-(--text-secondary)">
              {copy.externalTitle}
            </h3>
            <p className="sr-only">
              {externalRuntimes.length > 0
                ? copy.detectedModels(externalRuntimes.reduce((sum, item) => sum + item.models.length, 0))
                : copy.externalEmpty}
            </p>
          </div>
          <Button type="button" size="sm" variant="ghostMuted" disabled={probing} onClick={onProbeRuntimes}>
            <RefreshCw className="h-3 w-3" />
            {copy.actionProbe}
          </Button>
        </div>
        <div className="divide-y divide-(--border-subtle)">
          {runtimeInstallList.map((runtime) => {
            const detected = externalRuntimes.find((d) => d.runtimeId === runtime.id);
            return (
              <div key={runtime.id} className="py-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-medium text-(--text-primary)">{runtime.label}</p>
                  {runtime.running ? (
                    <Badge variant="successSoft">
                      {copy.runtimeConnected}
                      {runtime.latencyMs !== null ? ` · ${runtime.latencyMs}ms` : ""}
                    </Badge>
                  ) : runtime.installed ? (
                    <Badge variant="outline" className="text-(--text-muted)">
                      {copy.runtimeInstalledNotRunning}
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="border-(--warning)/40 bg-(--warning-soft) text-(--warning)">
                      {copy.runtimeNotInstalled}
                    </Badge>
                  )}
                </div>
                <p className="truncate text-xs text-(--text-muted)">{runtime.endpoint}</p>
                {runtime.running && detected && detected.models.length > 0 && (
                  <p className="sr-only">
                    {copy.detectedModels(runtime.modelsDetected)}: {detected.models.join(", ")}
                  </p>
                )}
                <div className="mt-2 flex flex-wrap gap-2">
                  {runtime.installed && !runtime.running && runtime.launchable && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghostMuted"
                      onClick={() => onLaunchRuntime(runtime.id)}
                    >
                      <Zap className="h-3 w-3" />
                      {copy.runtimeOpenApp}
                    </Button>
                  )}
                  {!runtime.installed && (
                    <a
                      href={runtime.installUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 rounded-md border border-(--border-subtle) px-2 py-1 text-xs text-(--text-secondary) hover:bg-(--bg-glass)"
                    >
                      <Download className="h-3 w-3" />
                      {copy.runtimeDownload}
                    </a>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
