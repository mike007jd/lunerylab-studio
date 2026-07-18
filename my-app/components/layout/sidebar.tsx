"use client";

import { usePathname, useRouter } from "next/navigation";
import { type ElementType, useCallback, useEffect, useState } from "react";
import {
  Bot,
  FolderOpen,
  Layers,
  Plus,
  Settings,
  X,
} from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { LunaLogo } from "@/components/ui/luna-logo";
import {
  Sidebar as SidebarPrimitive,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { useI18n } from "@/lib/i18n/provider";
import { TransitionLink } from "@/components/motion/transition-link";
import { useOptionalRouteTransition } from "@/components/motion/route-transition-provider";
import {
  SIDEBAR_RECENT_PROJECT_LIMIT,
} from "@/lib/constants/shell-navigation";
import {
  subscribeToProjectCreated,
  subscribeToProjectUpdated,
} from "@/lib/client/project-created-event";

export interface SidebarProject {
  id: string;
  name: string;
}

interface NavItem {
  href: string;
  icon: ElementType;
  label: string;
}

interface NavConfigItem {
  href: string;
  icon: ElementType;
  labelKey: string;
}

// Primary workspace navigation — the actual content surfaces. System config
// (Settings) is intentionally anchored in the footer, not listed here, so it
// sinks to the bottom and never competes with the workspace destinations.
const MAIN_NAV_CONFIG: NavConfigItem[] = [
  { href: "/studio", icon: Bot, labelKey: "nav.studio" },
  { href: "/projects", icon: Layers, labelKey: "nav.projects" },
  { href: "/library", icon: FolderOpen, labelKey: "nav.library" },
];

// Shared row chrome + active matcher so the in-content nav items and the
// footer-anchored Settings row stay visually and behaviourally identical.
const NAV_ROW_CLASS =
  "h-10 rounded-xl px-2.5 data-[active=true]:border data-[active=true]:border-(--accent-glow)/18 data-[active=true]:bg-(--accent-glow)/12 data-[active=true]:text-(--accent-glow)";

function isPathActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(href + "/");
}

function buildNavItems(items: NavConfigItem[], t: (key: string) => string): NavItem[] {
  return items.map(({ href, icon, labelKey }) => ({
    href,
    icon,
    label: t(labelKey),
  }));
}

/** Collapses the mobile off-canvas sidebar after navigation; a no-op on desktop. */
function useCloseMobileSidebar() {
  const { isMobile, setOpenMobile } = useSidebar();
  return () => {
    if (isMobile) {
      setOpenMobile(false);
    }
  };
}

function SidebarNavItem({
  href,
  icon: Icon,
  label,
  pathname,
}: NavItem & { pathname: string }) {
  const isActive = isPathActive(pathname, href);
  const closeMobileSidebar = useCloseMobileSidebar();

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={isActive}
        tooltip={label}
        className={NAV_ROW_CLASS}
      >
        <TransitionLink href={href} aria-label={label} onClick={closeMobileSidebar}>
          <Icon className="h-4 w-4" />
          <span className="truncate">{label}</span>
        </TransitionLink>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function NavSection({ items, pathname }: { items: NavItem[]; pathname: string }) {
  return (
    <SidebarGroup>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => (
            <SidebarNavItem key={item.href} {...item} pathname={pathname} />
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

/** Recent projects are shortcuts beneath the first-class Projects destination. */
function SidebarProjects({
  projects,
  pathname,
}: {
  projects: SidebarProject[];
  pathname: string;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const closeMobileSidebar = useCloseMobileSidebar();

  const handleCreateProject = () => {
    closeMobileSidebar();
    router.push("/projects?create=1");
  };

  return (
    <SidebarGroup>
      <div className="flex items-center gap-2 px-2">
        <SidebarGroupLabel className="min-w-0 flex-1 px-0">
          {t("nav.recentProjects")}
        </SidebarGroupLabel>
        <Button
          type="button"
          variant="ghostMuted"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={handleCreateProject}
          aria-label={t("studio.newProject")}
        >
          <Plus className="h-3.5 w-3.5" />
          {t("studio.newProject")}
        </Button>
      </div>
      <SidebarGroupContent>
        <SidebarMenu>
          {projects.length === 0 ? (
            <SidebarMenuItem>
              <p className="px-2.5 py-1.5 text-xs text-(--text-muted)">{t("common.noData")}</p>
            </SidebarMenuItem>
          ) : (
            projects.map((project) => (
              <SidebarNavItem
                key={project.id}
                href={`/projects/${project.id}`}
                icon={FolderOpen}
                label={project.name}
                pathname={pathname}
              />
            ))
          )}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

export function Sidebar({
  projects: initialProjects,
}: {
  projects: SidebarProject[];
}) {
  const pathname = usePathname();
  const routeTransition = useOptionalRouteTransition();
  const activePathname = routeTransition?.activePathname ?? pathname;
  const { t } = useI18n();
  const { isMobile, setOpenMobile } = useSidebar();
  const mainNav = buildNavItems(MAIN_NAV_CONFIG, t);
  const settingsActive = isPathActive(activePathname, "/settings");

  // Client-owned mirror of the server project list so a freshly created project
  // can be prepended optimistically (see SidebarProjects) without refetching the
  // whole force-dynamic console layout.
  const [projects, setProjects] = useState(() =>
    initialProjects.slice(0, SIDEBAR_RECENT_PROJECT_LIMIT),
  );
  const handleProjectUpserted = useCallback((project: SidebarProject) => {
    setProjects((current) => [
      project,
      ...current.filter((item) => item.id !== project.id),
    ].slice(0, SIDEBAR_RECENT_PROJECT_LIMIT));
  }, []);

  useEffect(() => {
    const unsubscribeCreated = subscribeToProjectCreated(handleProjectUpserted);
    const unsubscribeUpdated = subscribeToProjectUpdated(handleProjectUpserted);
    return () => {
      unsubscribeCreated();
      unsubscribeUpdated();
    };
  }, [handleProjectUpserted]);

  const closeMobileSidebar = useCloseMobileSidebar();

  return (
    <SidebarPrimitive
      collapsible="offcanvas"
      mobileTitle={t("shell.navigationTitle")}
      mobileDescription={t("shell.navigationDescription")}
      className="border-r border-(--border-subtle) bg-(--bg-surface)/72 backdrop-blur-2xl backdrop-saturate-150"
    >
      <SidebarHeader className="px-3 py-5">
        <div className="flex items-center gap-2">
          <SidebarMenu className="min-w-0 flex-1">
            <SidebarMenuItem>
              <SidebarMenuButton asChild className="h-10 rounded-xl px-2.5">
                <TransitionLink
                  href="/studio"
                  aria-label={t("shell.goToStudio")}
                  onClick={closeMobileSidebar}
                >
                  <LunaLogo size={20} />
                  <span className="text-sm font-semibold italic text-foreground">Lunery Lab</span>
                </TransitionLink>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
          {isMobile ? (
            <Button
              type="button"
              variant="ghostMuted"
              size="icon-sm"
              className="shrink-0"
              aria-label={t("shell.closeNavigation")}
              onClick={() => setOpenMobile(false)}
            >
              <X className="h-4 w-4" />
            </Button>
          ) : null}
        </div>
      </SidebarHeader>

      <SidebarContent className="px-1">
        <NavSection items={mainNav} pathname={activePathname} />
        <SidebarProjects
          projects={projects}
          pathname={activePathname}
        />
      </SidebarContent>

      <SidebarFooter className="px-3 pb-5">
        <SidebarSettingsRow
          label={t("nav.settings")}
          isActive={settingsActive}
          onNavigate={closeMobileSidebar}
        />
      </SidebarFooter>
    </SidebarPrimitive>
  );
}

/** Low-frequency configuration stays anchored away from creative destinations. */
function SidebarSettingsRow({
  label,
  isActive,
  onNavigate,
}: {
  label: string;
  isActive: boolean;
  onNavigate: () => void;
}) {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          asChild
          isActive={isActive}
          tooltip={label}
          className={NAV_ROW_CLASS}
        >
          <TransitionLink href="/settings" aria-label={label} onClick={onNavigate}>
            <Settings className="h-4 w-4" />
            <span>{label}</span>
          </TransitionLink>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
