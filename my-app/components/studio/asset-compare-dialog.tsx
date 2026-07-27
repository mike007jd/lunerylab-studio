import { AssetImage } from "@/components/ui/asset-image";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { AssetDTO } from "@/lib/types/api";
import { cn } from "@/lib/utils";

export interface PresentedAsset {
  asset: AssetDTO;
  prompt: string;
  position: number;
}

export function AssetCompareDialog({
  open,
  onOpenChange,
  assets,
  title,
  getAlt,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  assets: PresentedAsset[];
  title: string;
  getAlt: (position: number, prompt: string) => string;
}) {
  const gridClass =
    assets.length === 2
      ? "grid-cols-2"
      : assets.length === 3
        ? "grid-cols-2 sm:grid-cols-3"
        : "grid-cols-2 sm:grid-cols-4";
  return (
    <Dialog open={open && assets.length > 0} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] w-full max-w-[1400px] overflow-hidden bg-(--bg-surface) sm:max-w-[1400px]">
        <DialogHeader>
          <DialogTitle className="text-sm font-semibold uppercase tracking-[0.18em] text-(--text-secondary)">
            {title}
          </DialogTitle>
        </DialogHeader>
        <div className={cn("grid gap-3 overflow-y-auto", gridClass)}>
          {assets.map(({ asset, prompt, position }) => (
            <div
              key={asset.id}
              className="overflow-hidden rounded-xl border border-(--border-subtle) bg-(--bg-elevated)"
            >
              <AssetImage
                src={asset.url}
                alt={getAlt(position, prompt)}
                priority
                className="h-auto max-h-[78vh] w-full object-contain"
              />
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
