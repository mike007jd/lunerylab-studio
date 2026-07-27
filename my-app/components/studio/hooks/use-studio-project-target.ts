"use client";

import { useCallback, useMemo, useState } from "react";
import { useActiveProject } from "@/lib/client/active-project-provider";
import { createKeyedSingleFlight } from "@/lib/client/generation-presentation";
import { announceProjectCreated } from "@/lib/client/project-created-event";
import { createProject } from "@/lib/client/projects";
import { toErrorMessage } from "@/lib/client/fetch-json";
import type { TFunction } from "@/lib/i18n/provider";
import { buildDefaultProjectName } from "@/lib/project-name";
import {
  dedupeProjectOptions,
  resolveInitialSampleId,
} from "@/components/studio/studio-project-options";
import type { ProjectOption } from "@/components/studio/studio-constants";

export function useStudioProjectTarget({
  initialProjects,
  sampleId,
  t,
  setNotice,
}: {
  initialProjects: ProjectOption[];
  sampleId: string | null;
  t: TFunction;
  setNotice: (notice: string) => void;
}) {
  const { activeProjectId, setActiveProject } = useActiveProject();
  const [projects, setProjects] = useState(initialProjects);
  const [singleFlight] = useState(createKeyedSingleFlight);
  const [isCreating, setIsCreating] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState("");

  const projectId =
    activeProjectId && projects.some((project) => project.id === activeProjectId)
      ? activeProjectId
      : resolveInitialSampleId(sampleId, initialProjects);
  const options = useMemo(() => dedupeProjectOptions(projects), [projects]);
  const activeProjectName = options.find((project) => project.id === projectId)?.name;

  const openCreateDialog = useCallback(() => {
    setName(buildDefaultProjectName(t));
    setError("");
    setDialogOpen(true);
  }, [t]);

  const submitCreate = useCallback(
    async (nextName: string) => {
      await singleFlight.run("create-project", async () => {
        setIsCreating(true);
        setError("");
        try {
          const project = await createProject({ name: nextName });
          setProjects((current) => [
            project,
            ...current.filter((item) => item.id !== project.id),
          ]);
          setActiveProject(project.id);
          announceProjectCreated(project);
          setDialogOpen(false);
          setNotice(t("studio.projectCreated", { name: project.name }));
        } catch (createError) {
          setError(toErrorMessage(createError, t("studio.createProjectFailed")));
        } finally {
          setIsCreating(false);
        }
      });
    },
    [setActiveProject, setNotice, singleFlight, t],
  );

  const setDialogVisibility = useCallback((open: boolean) => {
    setDialogOpen(open);
    if (!open) setError("");
  }, []);

  return {
    projectId,
    options,
    activeProjectName,
    isCreating,
    openCreateDialog,
    changeProject: setActiveProject,
    dialog: {
      open: dialogOpen,
      name,
      error,
      setName,
      setOpen: setDialogVisibility,
      submit: submitCreate,
    },
  };
}
