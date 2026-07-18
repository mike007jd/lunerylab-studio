"use client";

import { type ReactNode, useSyncExternalStore } from "react";
import { motion } from "framer-motion";
import { lunaMotion, lunaVariants } from "@/components/design-system/grammar/motion";
import { cn } from "@/lib/utils";
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

interface MotionShellProps {
  children: ReactNode;
  className?: string;
  delay?: number;
}

interface HoverLiftProps {
  children: ReactNode;
  className?: string;
  hoverY?: number;
}

function subscribeToReducedMotion(onStoreChange: () => void) {
  const mediaQuery = window.matchMedia(REDUCED_MOTION_QUERY);
  mediaQuery.addEventListener("change", onStoreChange);
  return () => mediaQuery.removeEventListener("change", onStoreChange);
}

function getReducedMotionSnapshot() {
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

function getReducedMotionServerSnapshot() {
  return false;
}

// The server snapshot must match the first hydration render. The browser's real
// preference is applied immediately after hydration through the external-store
// subscription, avoiding different reduced-motion branches in the SSR markup.
export function useMotionReducedPreference() {
  return useSyncExternalStore(
    subscribeToReducedMotion,
    getReducedMotionSnapshot,
    getReducedMotionServerSnapshot,
  );
}

function unlessReduced<T>(reduced: boolean, value: T): T | undefined {
  return reduced ? undefined : value;
}

export function PageReveal({ children, className, delay = 0 }: MotionShellProps) {
  const reduced = useMotionReducedPreference();

  return (
    <motion.div
      className={cn("will-change-[transform,opacity]", className)}
      initial={reduced ? false : lunaVariants.rise.hidden}
      animate={unlessReduced(reduced, lunaVariants.rise.visible)}
      transition={unlessReduced(reduced, { ...lunaMotion.surface, delay })}
    >
      {children}
    </motion.div>
  );
}

export function HoverLiftCard({ children, className, hoverY = -3 }: HoverLiftProps) {
  const reduced = useMotionReducedPreference();

  return (
    <motion.div
      className={cn("will-change-transform", className)}
      whileHover={unlessReduced(reduced, { y: hoverY, scale: 1.008 })}
      whileTap={unlessReduced(reduced, { scale: 0.995 })}
      transition={unlessReduced(reduced, lunaMotion.lift)}
    >
      {children}
    </motion.div>
  );
}
