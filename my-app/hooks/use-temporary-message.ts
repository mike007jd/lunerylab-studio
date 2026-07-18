"use client";

import { useEffect, useRef } from "react";

export function useTemporaryMessage(
  value: string | null | undefined,
  clear: () => void,
  delayMs: number,
): void {
  const clearRef = useRef(clear);

  useEffect(() => {
    clearRef.current = clear;
  }, [clear]);

  useEffect(() => {
    if (!value) return;
    const timer = window.setTimeout(() => clearRef.current(), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, value]);
}
