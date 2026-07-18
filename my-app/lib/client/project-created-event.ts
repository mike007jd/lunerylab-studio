import { SIDEBAR_PROJECT_CREATED_EVENT } from "@/lib/constants/shell-navigation";

interface CreatedProjectSummary {
  id: string;
  name: string;
}

const PROJECT_UPDATED_EVENT = "lunery:project-updated";

/** Announces a successful creation to the persistent shell without a layout refetch. */
export function announceProjectCreated(project: CreatedProjectSummary): void {
  window.dispatchEvent(new CustomEvent(SIDEBAR_PROJECT_CREATED_EVENT, { detail: project }));
}

export function subscribeToProjectCreated(
  listener: (project: CreatedProjectSummary) => void,
): () => void {
  const handleEvent = (event: Event) => {
    const project = (event as CustomEvent<CreatedProjectSummary>).detail;
    if (project?.id && project.name) listener(project);
  };
  window.addEventListener(SIDEBAR_PROJECT_CREATED_EVENT, handleEvent);
  return () => window.removeEventListener(SIDEBAR_PROJECT_CREATED_EVENT, handleEvent);
}

/** Announces a renamed project without changing the creation event contract. */
export function announceProjectUpdated(project: CreatedProjectSummary): void {
  window.dispatchEvent(new CustomEvent(PROJECT_UPDATED_EVENT, { detail: project }));
}

export function subscribeToProjectUpdated(
  listener: (project: CreatedProjectSummary) => void,
): () => void {
  const handleEvent = (event: Event) => {
    const project = (event as CustomEvent<CreatedProjectSummary>).detail;
    if (project?.id && project.name) listener(project);
  };
  window.addEventListener(PROJECT_UPDATED_EVENT, handleEvent);
  return () => window.removeEventListener(PROJECT_UPDATED_EVENT, handleEvent);
}
