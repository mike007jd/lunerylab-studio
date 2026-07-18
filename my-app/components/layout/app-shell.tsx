"use client";

import { Sidebar as AppSidebar, type SidebarProject } from "@/components/layout/sidebar";
import { TopHeader } from "@/components/layout/top-header";
import {
  RouteTransitionProvider,
} from "@/components/motion/route-transition-provider";
import {
  SidebarInset,
  SidebarProvider,
} from "@/components/ui/sidebar";
import {
  CONSOLE_CONTENT_FRAME_CLASS,
  CONSOLE_CONTENT_SCOPE_CLASS,
} from "@/components/design-system/shell";

export function AppShell({
  children,
  initialProjects = [],
  defaultSidebarOpen = true,
}: {
  children: React.ReactNode;
  initialProjects?: SidebarProject[];
  defaultSidebarOpen?: boolean;
}) {
  return (
    <RouteTransitionProvider>
      <div className="min-h-screen bg-(--bg-base)">
        <SidebarProvider defaultOpen={defaultSidebarOpen}>
          <AppSidebar projects={initialProjects} />
          <SidebarInset className="min-h-screen min-w-0 bg-(--bg-base)">
            <TopHeader />
            <div id="console-content-scope" className={CONSOLE_CONTENT_SCOPE_CLASS}>
              <div className={CONSOLE_CONTENT_FRAME_CLASS}>{children}</div>
            </div>
          </SidebarInset>
        </SidebarProvider>
      </div>
    </RouteTransitionProvider>
  );
}
