"use client"

import * as React from "react"
import { Progress as ProgressPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function Progress({
  className,
  value,
  max = 100,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  const maxValue = typeof max === "number" && Number.isFinite(max) && max > 0 ? max : 100
  const clampedValue =
    typeof value === "number" && Number.isFinite(value)
      ? Math.min(maxValue, Math.max(0, value))
      : null
  const progressPercent = clampedValue === null ? 0 : (clampedValue / maxValue) * 100

  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      value={clampedValue}
      max={maxValue}
      className={cn(
        "relative h-2 w-full overflow-hidden rounded-full bg-primary/20",
        className
      )}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="h-full w-full flex-1 bg-primary transition-transform duration-(--motion-surface) ease-luna-out"
        style={{ transform: `translateX(-${100 - progressPercent}%)` }}
      />
    </ProgressPrimitive.Root>
  )
}

export { Progress }
