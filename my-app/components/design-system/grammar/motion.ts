// CSS mirrors: app/globals.css --motion-* and --ease-luna-*.
// Keep both sources numerically aligned whenever this grammar changes.
import type { Transition, Variants } from "framer-motion";

type Bezier = [number, number, number, number];

// Framer Motion expresses tween durations in seconds.
export const motionDuration = {
  micro: 0.12,
  control: 0.16,
  overlay: 0.2,
  modal: 0.24,
  surface: 0.26,
  exit: 0.16,
  stagger: 0.04,
} as const;

export const motionEase = {
  out: [0.22, 1, 0.36, 1] as Bezier,
  outSoft: [0.16, 1, 0.3, 1] as Bezier,
  in: [0.55, 0, 1, 0.45] as Bezier,
  inOut: [0.45, 0, 0.25, 1] as Bezier,
} as const;

export const motionSpring = {
  lift: { type: "spring", stiffness: 420, damping: 32, mass: 0.78 },
} as const satisfies Record<string, Transition>;

export const lunaMotion = {
  feedback: { duration: motionDuration.micro, ease: motionEase.out },
  control: { duration: motionDuration.control, ease: motionEase.out },
  overlay: { duration: motionDuration.overlay, ease: motionEase.out },
  modal: { duration: motionDuration.modal, ease: motionEase.inOut },
  surface: { duration: motionDuration.surface, ease: motionEase.outSoft },
  dismiss: { duration: motionDuration.exit, ease: motionEase.in },
  lift: motionSpring.lift,
} satisfies Record<string, Transition>;

export const lunaVariants = {
  fade: {
    hidden: { opacity: 0 },
    visible: { opacity: 1 },
    exit: { opacity: 0 },
  },
  rise: {
    hidden: { opacity: 0, y: 8 },
    visible: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: -6 },
  },
  scale: {
    hidden: { opacity: 0, scale: 0.98 },
    visible: { opacity: 1, scale: 1 },
    exit: { opacity: 0, scale: 0.99 },
  },
} satisfies Record<string, Variants>;

export function lunaVariant(name: keyof typeof lunaVariants, reduced: boolean): Variants {
  return reduced ? lunaVariants.fade : lunaVariants[name];
}
