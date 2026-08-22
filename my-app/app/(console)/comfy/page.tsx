import { ensureLocalWorkspaceOwner } from "@/lib/server/local-workspace-owner";
import { getComfyConnectionState } from "@/lib/server/comfy-connection-store";
import { ComfyWorkspace } from "@/components/comfy/comfy-workspace";

export const dynamic = "force-dynamic";

export default async function ComfyRoute() {
  await ensureLocalWorkspaceOwner();
  const initialState = getComfyConnectionState();
  return <ComfyWorkspace initialState={initialState} />;
}
