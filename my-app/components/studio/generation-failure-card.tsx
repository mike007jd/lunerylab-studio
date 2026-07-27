import { Info, RefreshCw } from "@/components/ui/icons";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function GenerationFailureCard({
  error,
  retryLabel,
  disabled,
  onRetry,
  tone = "destructive",
}: {
  error: string;
  retryLabel: string;
  disabled: boolean;
  onRetry: () => void;
  tone?: "destructive" | "muted";
}) {
  const muted = tone === "muted";
  return (
    <Alert
      variant={muted ? "default" : "destructive"}
      className={cn(
        "flex flex-col gap-3 rounded-lg sm:flex-row sm:items-center sm:justify-between",
        muted
          ? "border-transparent bg-(--bg-elevated)/60"
          : "border-transparent bg-destructive/5",
      )}
    >
      <AlertDescription
        className={cn(
          "flex items-start gap-2 text-xs",
          muted ? "text-(--text-secondary)" : "text-destructive",
        )}
      >
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span className="leading-snug">{error}</span>
      </AlertDescription>
      <Button
        type="button"
        onClick={onRetry}
        disabled={disabled}
        variant="outline"
        size="xs"
        className={cn(
          "self-start bg-(--bg-surface) sm:self-auto",
          muted
            ? "border-(--border-subtle) text-(--text-secondary) hover:bg-(--bg-elevated)"
            : "border-destructive/40 text-destructive hover:bg-destructive/10",
        )}
      >
        <RefreshCw className="h-3 w-3" />
        {retryLabel}
      </Button>
    </Alert>
  );
}
