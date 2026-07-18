import { requireLocalWorkspaceOwner } from "@/lib/server/local-workspace-owner";
import { ApiError, jsonError } from "@/lib/server/errors";
import { parseJsonBody } from "@/lib/server/http-validation";
import {
  createReferenceSet,
  listReferenceSets,
  parseReferenceSetAssetIds,
  referenceSetBodySchema,
} from "@/lib/server/reference-set";

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireLocalWorkspaceOwner();
    const { id } = await ctx.params;
    const sets = await listReferenceSets(id, user.id);
    return Response.json({ sets });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireLocalWorkspaceOwner();
    const { id } = await ctx.params;
    const body = await parseJsonBody(request, referenceSetBodySchema);
    if (!body?.name?.trim()) {
      throw new ApiError({
        status: 400,
        code: "invalid_request",
        message: "name is required.",
        retryable: false,
      });
    }
    const assetIds = parseReferenceSetAssetIds(body.assetIds) ?? [];
    const set = await createReferenceSet(id, user.id, {
      name: body.name,
      description: body.description,
      assetIds,
      isDefault: Boolean(body.isDefault),
    });
    return Response.json(set, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
