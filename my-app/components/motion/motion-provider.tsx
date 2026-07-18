"use client";

import { MotionConfig } from "framer-motion";
import { lunaMotion } from "@/components/design-system/grammar/motion";

export function MotionProvider({ children }: { children: React.ReactNode }) {
  return (
    <MotionConfig reducedMotion="user" transition={lunaMotion.overlay}>
      {children}
    </MotionConfig>
  );
}
