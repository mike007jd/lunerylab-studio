import { cn } from "@/lib/utils";

interface LunaLogoProps {
  className?: string;
  size?: number;
}

export function LunaLogo({ className, size = 32 }: LunaLogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("shrink-0", className)}
      aria-label="Lunery Lab"
    >
      <defs>
        <linearGradient id="luna-gold-gradient" x1="2" y1="16" x2="22" y2="16" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0" />
          <stop offset="50%" stopColor="currentColor" stopOpacity="0.5" />
          <stop offset="100%" stopColor="#D4AF37" />
        </linearGradient>
      </defs>
      {/* Inner offset orbit (Moon phase reference) */}
      <circle
        cx="12" cy="16" r="10"
        stroke="url(#luna-gold-gradient)"
        strokeWidth="1.5"
        fill="transparent"
      />
      {/* Star / Sparkle in the center */}
      <path
        d="M20 8L21.5 14L27.5 15.5L21.5 17L20 23L18.5 17L12.5 15.5L18.5 14L20 8Z"
        fill="currentColor"
      />
    </svg>
  );
}
