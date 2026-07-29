import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LOCAL_WORKSPACE_OWNER, ensureLocalWorkspaceOwner } from "@/lib/server/local-workspace-owner";
import { fetchProjectWorkspace } from "@/lib/server/queries";
import { ProjectWorkspace } from "@/components/library/project-workspace";
import { PageReveal } from "@/components/motion/motion-primitives";
import { prisma } from "@/lib/server/prisma";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  await ensureLocalWorkspaceOwner();
  const project = await prisma.project.findUnique({
    where: { id, userId: LOCAL_WORKSPACE_OWNER.id },
    select: { name: true },
  });
  if (!project?.name) {
    return { title: "Project" };
  }
  // Root layout template appends " — Lunery Lab Studio".
  return { title: project.name };
}

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
