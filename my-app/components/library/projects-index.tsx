"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ImageIcon,
  Layers,
  MoreHorizontal,
  PencilLine,
  Plus,
  Sparkles,
} from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { SurfaceCard } from "@/components/ui/page-primitives";
import { TransitionLink } from "@/components/motion/transition-link";
import { useT } from "@/lib/i18n/useT";
import { fetchJson, toErrorMessage } from "@/lib/client/fetch-json";
import {
  announceProjectCreated,
  announceProjectUpdated,
} from "@/lib/client/project-created-event";
import { AssetImage } from "@/components/ui/asset-image";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ProjectNameDialog } from "@/components/projects/project-name-dialog";
import { useI18n } from "@/lib/i18n/provider";
import { buildDefaultProjectName, resolveTemplateProjectName } from "@/lib/project-name";
import { formatRelativeTime } from "@/lib/relative-time";
import { createProject, renameProject } from "@/lib/client/projects";
import { formatProjectTemplateContents } from "@/lib/project-template-content";
import {
  mergeKeyedCursorPage,
  PROJECTS_PAGE_SIZE,
  type KeyedCursorPage,
} from "@/lib/project-pagination";

interface ProjectsIndexItem {
  id: string;
  name: string;
  updatedAt: string;
  jobCount: number;
  assetCount: number;
  canvasSessionCount: number;
}

interface ProjectsIndexPage {
  projects: ProjectsIndexItem[];
  hasMore: boolean;
  nextCursor: string | null;
}

interface ProjectTemplateItem {
  id: string;
  name: string;
  templateKey: string | null;
  previewUrl: string | null;
  assetCount: number;
  canvasCount: number;
}

const PROJECTS_SCOPE_KEY = "projects";

type ProjectNameDialogMode =
  | { kind: "create" }
  | { kind: "template"; templateId: string }
  | { kind: "rename"; projectId: string };

export function ProjectsIndex({
  initialPage,
  templates,
}: {
  initialPage: ProjectsIndexPage;
  templates: ProjectTemplateItem[];
}) {
  const t = useT();
  const { locale } = useI18n();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [projectPage, setProjectPage] = useState<KeyedCursorPage<ProjectsIndexItem>>({
    key: PROJECTS_SCOPE_KEY,
    items: initialPage.projects,
    hasMore: initialPage.hasMore,
    nextCursor: initialPage.nextCursor,
  });
  const [creating, setCreating] = useState(false);
  const [usingTemplateId, setUsingTemplateId] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [nameDialogMode, setNameDialogMode] = useState<ProjectNameDialogMode | null>(null);
  const [projectName, setProjectName] = useState("");
  const [nameDialogError, setNameDialogError] = useState("");
  const [savingRename, setSavingRename] = useState(false);
  const loadControllerRef = useRef<AbortController | null>(null);
  const projects = projectPage.items;
  const templateName = useCallback(
    (template: ProjectTemplateItem) => resolveTemplateProjectName(template, t),
    [t],
  );

  const openCreateProjectDialog = useCallback(() => {
    setProjectName(buildDefaultProjectName(t));
    setNameDialogError("");
    setNameDialogMode({ kind: "create" });
  }, [t]);

  useEffect(() => {
    if (searchParams.get("create") !== "1") return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      openCreateProjectDialog();
      router.replace("/projects", { scroll: false });
    });
    return () => {
      cancelled = true;
    };
  }, [openCreateProjectDialog, router, searchParams]);

  const handleCreateProject = async (name: string) => {
    if (creating) return;
    setCreating(true);
    setNameDialogError("");
    try {
      const project = await createProject({ name });
      announceProjectCreated(project);
      setNameDialogMode(null);
      router.push(`/projects/${project.id}`);
    } catch (requestError) {
      setNameDialogError(toErrorMessage(requestError, t("studio.createProjectFailed")));
    } finally {
      setCreating(false);
    }
  };

  const handleUseTemplate = async (templateId: string, name: string) => {
    if (usingTemplateId) return;
    setUsingTemplateId(templateId);
    setNameDialogError("");
    try {
      const project = await createProject({ templateId, name });
      announceProjectCreated(project);
      setNameDialogMode(null);
      router.push(`/projects/${project.id}`);
    } catch (requestError) {
      setNameDialogError(toErrorMessage(requestError, t("studio.createProjectFailed")));
    } finally {
      setUsingTemplateId(null);
    }
  };

  const handleRenameProject = async (projectId: string, name: string) => {
    if (savingRename) return;
    setSavingRename(true);
    setNameDialogError("");
    try {
      const project = await renameProject(projectId, name);
      setProjectPage((current) => {
        const renamed = current.items.find((item) => item.id === project.id);
        if (!renamed) return current;
        return {
          ...current,
          items: [
            { ...renamed, name: project.name, updatedAt: project.updatedAt },
            ...current.items.filter((item) => item.id !== project.id),
          ],
        };
      });
      announceProjectUpdated(project);
      setNameDialogMode(null);
    } catch (requestError) {
      setNameDialogError(toErrorMessage(requestError, t("library.renameProjectFailed")));
    } finally {
      setSavingRename(false);
    }
  };

  const handleProjectNameSubmit = async (name: string) => {
    if (!nameDialogMode) return;
    if (nameDialogMode.kind === "create") {
      await handleCreateProject(name);
      return;
    }
    if (nameDialogMode.kind === "template") {
      await handleUseTemplate(nameDialogMode.templateId, name);
      return;
    }
    await handleRenameProject(nameDialogMode.projectId, name);
  };

  const loadMoreProjects = useCallback(async () => {
    if (!projectPage.hasMore || !projectPage.nextCursor || loadControllerRef.current) return;

    const controller = new AbortController();
    loadControllerRef.current = controller;
    setLoadingMore(true);
    setLoadError("");
    try {
      const params = new URLSearchParams({
        cursor: projectPage.nextCursor,
        limit: String(PROJECTS_PAGE_SIZE),
      });
      const page = await fetchJson<ProjectsIndexPage>(
        `/api/projects?${params.toString()}`,
        { cache: "no-store", signal: controller.signal },
      );
      if (controller.signal.aborted || loadControllerRef.current !== controller) return;
      setProjectPage((current) =>
        mergeKeyedCursorPage(current, PROJECTS_SCOPE_KEY, {
          items: page.projects,
          hasMore: page.hasMore,
          nextCursor: page.nextCursor,
        }),
      );
    } catch (requestError) {
      if (!controller.signal.aborted && loadControllerRef.current === controller) {
        setLoadError(toErrorMessage(requestError, t("library.loadDetailFailed")));
      }
    } finally {
      if (loadControllerRef.current === controller) loadControllerRef.current = null;
      if (!controller.signal.aborted) setLoadingMore(false);
    }
  }, [projectPage.hasMore, projectPage.nextCursor, t]);

  useEffect(() => () => loadControllerRef.current?.abort(), []);

  return (
    <section className="min-w-0 w-full space-y-5">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {projects.length > 0 ? (
          <Button
            type="button"
            size="sm"
            variant="accent"
            loading={creating}
            onClick={openCreateProjectDialog}
          >
            <Plus className="h-4 w-4" />
            {t("studio.newProject")}
          </Button>
        ) : null}
        <Button asChild size="sm" variant="mutedOutline">
          <TransitionLink href="/studio">
            <Sparkles className="h-4 w-4" />
            {t("nav.studio")}
          </TransitionLink>
        </Button>
      </div>
      {templates.length > 0 ? (
        <div className="space-y-3">
          <div>
            <h2 className="text-sm font-semibold text-foreground">{t("library.templatesTitle")}</h2>
            <p className="mt-1 text-xs text-(--text-muted)">{t("library.templatesDescription")}</p>
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {templates.map((template) => (
              <SurfaceCard key={template.id} className="overflow-hidden p-0">
                <div className="aspect-[16/9] bg-(--bg-elevated)">
                  {template.previewUrl ? (
                    <AssetImage
                      src={template.previewUrl}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  ) : null}
                </div>
                <div className="space-y-3 p-4">
                  <div>
                    <h3 className="text-sm font-semibold text-foreground">{templateName(template)}</h3>
                    <p className="mt-1 text-xs text-(--text-muted)">
                      {formatProjectTemplateContents(
                        t,
                        template.assetCount,
                        template.canvasCount,
                      )}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    loading={usingTemplateId === template.id}
                    disabled={Boolean(usingTemplateId)}
                    onClick={() => {
                      setProjectName(templateName(template));
                      setNameDialogError("");
                      setNameDialogMode({ kind: "template", templateId: template.id });
                    }}
                  >
                    {t("library.useTemplate")}
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                </div>
              </SurfaceCard>
            ))}
          </div>
        </div>
      ) : null}

      {projects.length === 0 ? (
        <SurfaceCard>
          <div className="flex flex-col gap-3 text-sm text-(--text-muted)">
            <p>{t("studio.noProjects")}</p>
            <Button
              type="button"
              size="sm"
              variant="accent"
              className="w-fit"
              loading={creating}
              onClick={openCreateProjectDialog}
            >
              <Plus className="h-4 w-4" />
              {t("studio.newProject")}
            </Button>
          </div>
        </SurfaceCard>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {projects.map((project) => (
              <SurfaceCard key={project.id} className="group relative flex h-full flex-col gap-4">
                <TransitionLink
                  href={`/projects/${project.id}`}
                  className="absolute inset-0 z-0 rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={project.name}
                />
                <div className="pointer-events-none relative z-10 flex h-full flex-col gap-4">
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="truncate text-sm font-semibold text-foreground">
                        {project.name}
                      </h2>
                      <p className="mt-1 text-xs text-(--text-muted)">
                        {t("library.sessionInfo", {
                          updatedAt: formatRelativeTime(
                            project.updatedAt,
                            locale,
                            t("assetActions.justNow"),
                          ),
                        })}
                      </p>
                    </div>
                    <div className="pointer-events-auto flex items-center gap-1">
                      <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-(--text-muted) transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            type="button"
                            variant="ghostMuted"
                            size="icon-sm"
                            aria-label={t("library.renameProject")}
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onSelect={() => {
                              setProjectName(project.name);
                              setNameDialogError("");
                              setNameDialogMode({ kind: "rename", projectId: project.id });
                            }}
                          >
                            <PencilLine className="h-4 w-4" />
                            {t("library.renameProject")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-2 text-xs text-(--text-muted)">
                    <span className="inline-flex min-w-0 items-center gap-1.5 rounded-lg border border-(--border-subtle) px-2 py-1">
                      <ImageIcon className="h-3.5 w-3.5 shrink-0" aria-hidden />
                      <span className="truncate">
                        {t("library.projectAssets", { count: project.assetCount })}
                      </span>
                    </span>
                    <span className="inline-flex min-w-0 items-center gap-1.5 rounded-lg border border-(--border-subtle) px-2 py-1">
                      <Sparkles className="h-3.5 w-3.5 shrink-0" aria-hidden />
                      <span className="truncate">
                        {t("library.projectGenerations", { count: project.jobCount })}
                      </span>
                    </span>
                    <span className="inline-flex min-w-0 items-center gap-1.5 rounded-lg border border-(--border-subtle) px-2 py-1">
                      <Layers className="h-3.5 w-3.5 shrink-0" aria-hidden />
                      <span className="truncate">
                        {t("library.projectCanvases", { count: project.canvasSessionCount })}
                      </span>
                    </span>
                  </div>
                </div>
              </SurfaceCard>
            ))}
          </div>
          {projectPage.hasMore ? (
            <div className="flex justify-center">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                loading={loadingMore}
                onClick={() => void loadMoreProjects()}
              >
                {t("studio.libraryTabs.loadMore")}
              </Button>
            </div>
          ) : null}
          {loadError ? <p role="alert" className="text-center text-sm text-destructive">{loadError}</p> : null}
        </>
      )}
      <ProjectNameDialog
        open={nameDialogMode !== null}
        name={projectName}
        title={
          nameDialogMode?.kind === "rename"
            ? t("library.renameProject")
            : nameDialogMode?.kind === "template"
              ? t("library.useTemplate")
              : t("studio.newProject")
        }
        description={t("library.projectNameDescription")}
        inputLabel={t("agent.projectName")}
        submitLabel={
          nameDialogMode?.kind === "rename"
            ? t("common.save")
            : nameDialogMode?.kind === "template"
              ? t("library.useTemplate")
              : t("studio.newProject")
        }
        cancelLabel={t("common.cancel")}
        pending={creating || Boolean(usingTemplateId) || savingRename}
        error={nameDialogError}
        onNameChange={setProjectName}
        onOpenChange={(open) => {
          if (!open) {
            setNameDialogMode(null);
            setNameDialogError("");
          }
        }}
        onSubmit={handleProjectNameSubmit}
      />
    </section>
  );
}
