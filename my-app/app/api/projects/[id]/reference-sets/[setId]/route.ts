import { requireLocalWorkspaceOwner } from "@/lib/server/local-workspace-owner";
import { jsonError } from "@/lib/server/errors";
import { parseJsonBody } from "@/lib/server/http-validation";
import {
  deleteReferenceSet,
  parseReferenceSetAssetIds,
  referenceSetBodySchema,
  updateReferenceSet,
} from "@/lib/server/reference-set";

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string; setId: string }> },
) {
  try {
    const user = await requireLocalWorkspaceOwner();
    const { id, setId } = await ctx.params;
    const body = await parseJsonBody(request, referenceSetBodySchema);
    const assetIds = parseReferenceSetAssetIds(body.assetIds) ?? undefined;
    const updated = await updateReferenceSet(id, user.id, setId, {
      name: body.name,
      description: body.description,
      assetIds,
      isDefault: body.isDefault,
    });
    return Response.json(updated);
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(
  _request: Request,
  ctx: { params: Promise<{ id: string; setId: string }> },
) {
  try {
    const user = await requireLocalWorkspaceOwner();
    const { id, setId } = await ctx.params;
    await deleteReferenceSet(id, user.id, setId);
    return new Response(null, { status: 204 });
  } catch (error) {
    return jsonError(error);
  }
}
