import { LOCAL_WORKSPACE_OWNER, ensureLocalWorkspaceOwner } from "@/lib/server/local-workspace-owner";
import { fetchProjectOptions } from "@/lib/server/queries";
import { StudioPage } from "@/components/studio/studio-page";

export const dynamic = "force-dynamic";

export default async function StudioRoute() {
  await ensureLocalWorkspaceOwner();

  const projects = await fetchProjectOptions(LOCAL_WORKSPACE_OWNER.id);

  return (
    <StudioPage
      initialProjects={projects}
    />
  );
}
