import type * as React from "react";
import { cn } from "@/lib/utils";

type SurfaceShellProps = React.ComponentProps<"main"> & {
  width?: "standard" | "wide" | "full";
};

const widthClass = {
  standard: "max-w-screen-xl",
  wide: "max-w-screen-2xl",
  full: "max-w-none",
} as const;

export function SurfaceShell({
  children,
  className,
  width = "standard",
  ...props
}: SurfaceShellProps) {
  return (
    <main
      className={cn(
        "mx-auto flex w-full flex-col gap-8 px-4 py-6 sm:px-6 lg:px-8",
        widthClass[width],
        className,
      )}
      {...props}
    >
      {children}
    </main>
  );
}

export function SurfaceSection({
  className,
  ...props
}: React.ComponentProps<"section">) {
  return <section className={cn("flex w-full flex-col gap-4", className)} {...props} />;
}

