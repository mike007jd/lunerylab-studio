import { type ReactNode } from "react";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import {
  Empty,
  EmptyContent,
} from "@/components/ui/empty";
import { cn } from "@/lib/utils";

interface SurfaceCardProps {
  children: ReactNode;
  className?: string;
}

export function SurfaceCard({ children, className }: SurfaceCardProps) {
  return (
    <Card className="rounded-xl p-0 shadow-(--shadow-sm)">
      <CardContent className={cn("p-5 sm:p-6", className)}>
        {children}
      </CardContent>
    </Card>
  );
}

interface EmptyStateCardProps {
  children: ReactNode;
  className?: string;
}

export function EmptyStateCard({ children, className }: EmptyStateCardProps) {
  return (
    <Empty className={cn("rounded-xl border border-dashed border-(--border-subtle) p-6 text-sm text-(--text-muted)", className)}>
      <EmptyContent>{children}</EmptyContent>
    </Empty>
  );
}
