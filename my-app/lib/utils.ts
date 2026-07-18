import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Promise-based `setTimeout`. Used by polling loops in `byok-shared.ts`,
 * `byok-image.ts`, video status polling, etc. Lived inline as
 * `new Promise((r) => setTimeout(r, ms))` in half a dozen places before
 * we hoisted it here.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
