import { CreativeCapabilityReadinessProvider } from "@/hooks/use-creative-capability-readiness";
import { BootstrapSnapshotProvider } from "@/lib/client/bootstrap-snapshot-provider";

export default async function CanvasLayout({ children }: { children: React.ReactNode }) {
  return (
    <BootstrapSnapshotProvider intervalMs={10_000}>
      <CreativeCapabilityReadinessProvider>
        {children}
      </CreativeCapabilityReadinessProvider>
    </BootstrapSnapshotProvider>
  );
}
