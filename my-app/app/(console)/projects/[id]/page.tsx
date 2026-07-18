import { notFound } from "next/navigation";
import { LOCAL_WORKSPACE_OWNER, ensureLocalWorkspaceOwner } from "@/lib/server/local-workspace-owner";
import { fetchProjectWorkspace } from "@/lib/server/queries";
import { ProjectWorkspace } from "@/components/library/project-workspace";
import { PageReveal } from "@/components/motion/motion-primitives";

export const dynamic = "force-dynamic";

export default async function ProjectRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await ensureLocalWorkspaceOwner();
  const workspace = await fetchProjectWorkspace(LOCAL_WORKSPACE_OWNER.id, id);
  if (!workspace) notFound();

  return (
    <PageReveal>
      <section className="min-w-0 w-full space-y-6">
        <ProjectWorkspace
          projectId={workspace.project.id}
          heading={workspace.project.name}
          initialDetail={{
            key: workspace.project.id,
            canvasSessions: workspace.canvasSessions.items,
            canvasSessionsHasMore: workspace.canvasSessions.hasMore,
            canvasSessionsNextCursor: workspace.canvasSessions.nextCursor,
            jobs: workspace.jobs.items,
            jobsHasMore: workspace.jobs.hasMore,
            jobsNextCursor: workspace.jobs.nextCursor,
          }}
          initialAssets={workspace.assets}
          initialAssetCounts={workspace.assetCounts}
          initialAssetsHasMore={workspace.assetsHasMore}
          initialAssetsCursor={workspace.assetsNextCursor}
        />
      </section>
    </PageReveal>
  );
}
