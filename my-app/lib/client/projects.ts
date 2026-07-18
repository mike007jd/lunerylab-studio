"use client";

import { fetchJson } from "@/lib/client/fetch-json";

export interface ProjectSummary {
  id: string;
  name: string;
}

export interface RenamedProjectSummary extends ProjectSummary {
  updatedAt: string;
}

export async function createProject(input: {
  name: string;
  templateId?: string;
}): Promise<ProjectSummary> {
  const { project } = await fetchJson<{ project: ProjectSummary }>("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return project;
}

export async function renameProject(
  projectId: string,
  name: string,
): Promise<RenamedProjectSummary> {
  const { project } = await fetchJson<{ project: RenamedProjectSummary }>(
    `/api/projects/${encodeURIComponent(projectId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    },
  );
  return project;
}
