import type { ProjectOption } from "@/components/studio/studio-constants";

export function dedupeProjectOptions(projects: ProjectOption[]): ProjectOption[] {
  const seen = new Set<string>();
  const result: ProjectOption[] = [];

  for (const project of projects) {
    if (!project.id || seen.has(project.id)) {
      continue;
    }
    seen.add(project.id);
    result.push(project);
  }

  return result;
}

function resolveInitialProjectId(projects: ProjectOption[]): string {
  return dedupeProjectOptions(projects)[0]?.id ?? "";
}

export function resolveInitialSampleId(
  sampleParam: string | null | undefined,
  projects: ProjectOption[],
): string {
  if (sampleParam && projects.some((project) => project.id === sampleParam)) {
    return sampleParam;
  }
  return resolveInitialProjectId(projects);
}
