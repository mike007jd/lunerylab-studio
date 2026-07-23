import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { AppShell } from "@/components/layout/app-shell";
import { BootstrapSnapshotProvider } from "@/lib/client/bootstrap-snapshot-provider";
import { ActiveProjectProvider } from "@/lib/client/active-project-provider";
import { CreativeCapabilityReadinessProvider } from "@/hooks/use-creative-capability-readiness";
import { isDesktopRuntime } from "@/lib/desktop-runtime";
import { LOCAL_WORKSPACE_OWNER, ensureLocalWorkspaceOwner } from "@/lib/server/local-workspace-owner";
import { fetchBootstrapData, fetchSidebarProjects } from "@/lib/server/queries";
import type { BootstrapSnapshot } from "@/lib/client/use-bootstrap-snapshot";
import { PUBLIC_SITE_DOWNLOAD_URL } from "@/lib/public-site";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

async function getInitialBootstrap(): Promise<BootstrapSnapshot> {
  const { app, providers, providerConnections } = await fetchBootstrapData(
    LOCAL_WORKSPACE_OWNER.id,
  );
  return { user: LOCAL_WORKSPACE_OWNER, app, providers, providerConnections };
}

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  if (!isDesktopRuntime()) {
    redirect(PUBLIC_SITE_DOWNLOAD_URL);
  }
  await ensureLocalWorkspaceOwner();
  const [initialBootstrap, projects, cookieStore] = await Promise.all([
    getInitialBootstrap(),
    fetchSidebarProjects(LOCAL_WORKSPACE_OWNER.id),
    cookies(),
  ]);
  const defaultSidebarOpen = cookieStore.get("sidebar_state")?.value !== "false";
  return (
    <BootstrapSnapshotProvider initialData={initialBootstrap} intervalMs={10_000}>
      <CreativeCapabilityReadinessProvider>
        <ActiveProjectProvider>
          <AppShell initialProjects={projects} defaultSidebarOpen={defaultSidebarOpen}>
            {children}
          </AppShell>
        </ActiveProjectProvider>
      </CreativeCapabilityReadinessProvider>
    </BootstrapSnapshotProvider>
  );
}
