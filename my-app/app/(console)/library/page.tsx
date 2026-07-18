import { LOCAL_WORKSPACE_OWNER, ensureLocalWorkspaceOwner } from "@/lib/server/local-workspace-owner";
import { fetchLibraryAssets } from "@/lib/server/queries";
import { LibraryAllView } from "@/components/library/library-all-view";

export const dynamic = "force-dynamic";

export default async function LibraryRoute() {
  await ensureLocalWorkspaceOwner();
  const initialPage = await fetchLibraryAssets(LOCAL_WORKSPACE_OWNER.id);
  return <LibraryAllView initialPage={initialPage} />;
}
