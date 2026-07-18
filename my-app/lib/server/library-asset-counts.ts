import "server-only";

import type { Prisma } from "@prisma/client";
import { summarizeLibraryAssetCountGroups } from "@/lib/library-search";
import { prisma } from "@/lib/server/prisma";

const visibleLibraryAssetScope = {
  OR: [
    { projectId: null },
    { project: { is: { isTemplate: false } } },
  ],
} satisfies Prisma.AssetWhereInput;

/** Original template rows power the template catalog, not the user's Library. */
export function withVisibleLibraryAssetScope(
  where: Prisma.AssetWhereInput,
): Prisma.AssetWhereInput {
  return { AND: [where, visibleLibraryAssetScope] };
}

export async function fetchLibraryAssetCounts(where: Prisma.AssetWhereInput) {
  const scopeWhere = { ...where };
  delete scopeWhere.deletedAt;
  const visibleWhere = withVisibleLibraryAssetScope(scopeWhere);
  const [groups, trash] = await Promise.all([
    prisma.asset.groupBy({
      by: ["kind", "modality", "origin"],
      where: { AND: [visibleWhere, { deletedAt: null }] },
      _count: { _all: true },
    }),
    prisma.asset.count({ where: { AND: [visibleWhere, { deletedAt: { not: null } }] } }),
  ]);

  return summarizeLibraryAssetCountGroups(groups, trash);
}
