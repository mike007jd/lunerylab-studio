import { ProjectsIndex } from "@/components/library/projects-index";
import { PageReveal } from "@/components/motion/motion-primitives";
import { LOCAL_WORKSPACE_OWNER, ensureLocalWorkspaceOwner } from "@/lib/server/local-workspace-owner";
import { fetchProjects } from "@/lib/server/queries";
import { fetchProjectTemplates } from "@/lib/server/project-templates";

export const dynamic = "force-dynamic";

export default async function ProjectsRoute() {
  await ensureLocalWorkspaceOwner();

  const [initialPage, templates] = await Promise.all([
    fetchProjects(LOCAL_WORKSPACE_OWNER.id),
    fetchProjectTemplates(LOCAL_WORKSPACE_OWNER.id),
  ]);

  return (
    <PageReveal>
      <ProjectsIndex initialPage={initialPage} templates={templates} />
    </PageReveal>
  );
}
