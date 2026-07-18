"use client";

import { useEffect, useState } from "react";

/**
 * Returns a debounced copy of `value` that only updates after `delayMs` of
 * quiet time. Use it to keep an input instantly responsive while throttling the
 * expensive work it drives (filtering, network calls) — e.g. library search:
 * bind the input to immediate state, feed `useDebouncedValue(query)` to the
 * filter memo.
 */
export function useDebouncedValue<T>(value: T, delayMs = 180): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);

  return debounced;
}
