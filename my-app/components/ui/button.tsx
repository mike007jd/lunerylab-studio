import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"
import { Loader2 } from "lucide-react"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "relative inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-[color,background-color,border-color,box-shadow,opacity,transform] duration-(--motion-control) ease-luna-out disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive cursor-pointer active:scale-[0.98]",
  {
    variants: {
      variant: {
        default:
          "luna-btn-starlight",
        accent:
          "luna-btn-silver",
        destructive:
          "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60",
        gold:
          "bg-(--accent-glow) text-(--bg-base) hover:bg-(--accent-glow)/90",
        outline:
          "border border-(--border-subtle) bg-transparent text-foreground shadow-[var(--shadow-outline-inset)] hover:bg-(--bg-glass) hover:border-(--border-active) hover:text-foreground",
        mutedOutline:
          "border border-(--border-subtle) bg-(--bg-surface) text-muted-foreground/80 shadow-none hover:border-(--border-active) hover:bg-(--bg-glass) hover:text-foreground",
        selected:
          "border border-(--border-active) bg-(--bg-glass) text-foreground shadow-(--shadow-sm) hover:border-(--border-active) hover:bg-(--bg-elevated)",
        accentSoft:
          "border border-(--accent-primary) bg-(--border-active) text-(--accent-primary) hover:opacity-95",
        iconSubtle:
          "border border-(--border-subtle) bg-transparent text-muted-foreground/80 shadow-none hover:border-(--border-active) hover:bg-(--bg-glass) hover:text-foreground",
        secondary:
          "border border-(--border-subtle) bg-secondary text-secondary-foreground hover:bg-secondary/85 hover:border-(--border-active)",
        ghost:
          "text-muted-foreground hover:bg-(--bg-glass) hover:text-foreground",
        ghostMuted:
          "text-muted-foreground/80 hover:bg-(--bg-glass) hover:text-foreground",
        ghostPrimary:
          "text-primary hover:bg-primary/10 hover:text-primary",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 min-h-11 min-w-11 px-4 py-2 has-[>svg]:px-3 has-[[data-slot=button-content]_svg]:px-3",
        xs: "h-6 min-h-0 min-w-0 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 has-[[data-slot=button-content]_svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 min-h-0 min-w-0 rounded-lg gap-1.5 px-3 has-[>svg]:px-2.5 has-[[data-slot=button-content]_svg]:px-2.5",
        chip: "h-8 min-h-0 min-w-0 rounded-lg px-3 text-xs",
        tool: "h-9 min-h-0 min-w-0 w-full justify-start gap-1.5 rounded-xl px-3 text-xs font-medium",
        toolbar: "h-7 min-h-0 min-w-0 rounded-lg px-2 text-xs font-semibold uppercase tracking-[0.15em]",
        lg: "h-11 min-h-11 min-w-11 rounded-xl px-6 has-[>svg]:px-4 has-[[data-slot=button-content]_svg]:px-4",
        cta: "h-10 min-h-0 min-w-0 rounded-xl px-5 text-sm font-semibold",
        message: "h-auto min-h-0 min-w-0 rounded-xl px-4 py-2 text-xs font-semibold",
        icon: "size-9 min-h-0 min-w-0",
        "icon-toolbar": "h-7 w-7 min-h-0 min-w-0 rounded-full",
        "icon-md": "h-9 w-9 min-h-0 min-w-0",
        "icon-chat": "h-8 w-8 min-h-0 min-w-0 rounded-xl p-0",
        "icon-xs": "size-6 min-h-0 min-w-0 rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8 min-h-0 min-w-0",
        "icon-lg": "size-10 min-h-0 min-w-0",
      },
      width: {
        auto: "",
        full: "w-full",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
      width: "auto",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  loading = false,
  disabled,
  children,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
    /** Shows a spinner, sets aria-busy, and blocks interaction while true. */
    loading?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  // asChild renders a foreign element (e.g. a Link/anchor) through Slot, which
  // accepts only a single child — so we can't inject a spinner there. We still
  // expose aria-busy and forward disabled so consumer content stays intact.
  if (asChild) {
    return (
      <Comp
        data-slot="button"
        data-variant={variant}
        data-size={size}
        className={cn(buttonVariants({ variant, size, className }))}
        aria-busy={loading || undefined}
        disabled={disabled}
        {...props}
      >
        {children}
      </Comp>
    )
  }

  return (
    <button
      type="button"
      data-slot="button"
      data-variant={variant}
      data-size={size}
      data-loading={loading ? "" : undefined}
      className={cn(buttonVariants({ variant, size, className }))}
      aria-busy={loading || undefined}
      disabled={loading || disabled}
      {...props}
    >
      {/* Loading must not resize the button or move adjacent chrome: the
          spinner is overlaid on the padding box while the children keep their
          exact footprint (display:contents preserves the flex layout; inherited
          visibility:hidden hides them without collapsing their space).

          The icon padding rule must therefore see ONLY the caller's own icons:
          it matches a direct `> svg` (the asChild path, where Slot puts the
          button classes on the consumer's element) or an svg inside
          `button-content`. The overlay spinner is an svg too, but it lives
          outside `button-content` and under a `span`, so it can never flip a
          text-only button from px-4 to px-3 while it loads. A bare
          `has-[svg]` would do exactly that — the gate forbids it. */}
      {loading ? (
        <span
          data-slot="button-spinner"
          className="pointer-events-none absolute inset-0 flex items-center justify-center"
          aria-hidden="true"
        >
          <Loader2 className="size-4 animate-spin" />
        </span>
      ) : null}
      <span
        data-slot="button-content"
        className={cn("contents", loading && "invisible")}
      >
        {children}
      </span>
    </button>
  )
}

export { Button, buttonVariants }
