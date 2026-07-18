"use client";

import { cn } from "@/lib/utils";
import type { AccelInfo, HardwareInfo } from "@/lib/desktop-runtime";
import { accelChipClass } from "./catalog-utils";
import type { CopyShape } from "./copy";

export function HardwareStatusBar({
  accel,
  hw,
  copy,
}: {
  accel: AccelInfo | null;
  hw: HardwareInfo | null;
  copy: CopyShape;
}) {
  if (!accel && !hw) return null;
  const gpu = accel?.gpu ?? "cpu";
  const label =
    gpu === "metal"
      ? copy.accel.metal
      : gpu === "cuda"
        ? `${accel?.vendor ?? "NVIDIA"} · ${copy.accel.cuda}`
        : gpu === "vulkan"
          ? `${accel?.vendor ?? "GPU"} · ${copy.accel.vulkan}`
          : copy.accel.cpu;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
      {/* Neutral container: passive system info shouldn't wear the brand accent.
          Only the acceleration type carries a small accent chip as a positive cue. */}
      <span
        className={cn(
          "inline-flex items-center rounded-md px-2 py-0.5 text-[0.7rem] font-medium",
          accelChipClass(gpu),
        )}
      >
        {label}
      </span>
      {hw && (
        <span className="text-xs text-(--text-muted)">
          {copy.accelRam(hw.ram_gb, hw.disk_available_gb)}
        </span>
      )}
    </div>
  );
}
