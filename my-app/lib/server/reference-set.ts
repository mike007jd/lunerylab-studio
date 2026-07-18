/**
 * Reference Set helpers — project-scoped, named bundles of asset ids that the
 * agent can attach as the reference image stack for a generation.
 */

import "server-only";
import { z } from "zod";
import { prisma } from "@/lib/server/prisma";
import { ApiError, withPrismaNotFound } from "@/lib/server/errors";
import { assertOwnedProject } from "@/lib/server/project-ownership";

const MAX_REFERENCE_SETS_PER_PROJECT = 24;

/**
 * Request-body schema shared by the reference-set create + update routes — both
 * accept the same fields, so a single definition keeps them from drifting.
 * Permissive by design: `assetIds` stays `unknown` because each route runs its
 * own `Array.isArray(...).filter(string)`, and `name` is enforced by the create
 * route's own check rather than the schema.
 */
export const referenceSetBodySchema = z.object({
  name: z.string().optional(),
  description: z.string().nullish(),
  assetIds: z.unknown().optional(),
  isDefault: z.boolean().optional(),
});

function normalizeReferenceSetAssetIds(assetIds: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of assetIds) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    normalized.push(id);
  }
  return normalized;
}

export function parseReferenceSetAssetIds(value: unknown): string[] | null {
  return Array.isArray(value)
    ? normalizeReferenceSetAssetIds(value.filter((item): item is string => typeof item === "string"))
    : null;
}

export interface ReferenceSetSnapshot {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  assetIds: string[];
  isDefault: boolean;
  updatedAt: string;
}

// Hydrate the ordered membership rows into the flat, ordered assetIds the rest
// of the app consumes — the public snapshot contract is unchanged.
const referenceSetInclude = {
  assets: { orderBy: { position: "asc" as const }, select: { assetId: true } },
} as const;

function toSnapshot(row: {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  assets: { assetId: string }[];
  isDefault: boolean;
  updatedAt: Date;
}): ReferenceSetSnapshot {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    description: row.description,
    assetIds: row.assets.map((a) => a.assetId),
    isDefault: row.isDefault,
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function filterValidAssetIds(
  userId: string,
  projectId: string,
  assetIds: string[],
): Promise<string[]> {
  const normalizedAssetIds = normalizeReferenceSetAssetIds(assetIds);
  if (normalizedAssetIds.length === 0) return [];
  const valid = await prisma.asset.findMany({
    where: { id: { in: normalizedAssetIds }, userId, projectId },
    select: { id: true },
  });
  const validSet = new Set(valid.map((a) => a.id));
  return normalizedAssetIds.filter((id) => validSet.has(id)).slice(0, 32);
}

export async function listReferenceSets(
  projectId: string,
  userId: string,
): Promise<ReferenceSetSnapshot[]> {
  await assertOwnedProject(projectId, userId);
  const rows = await prisma.referenceSet.findMany({
    where: { projectId },
    orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
    include: referenceSetInclude,
  });
  return rows.map(toSnapshot);
}

export async function getDefaultReferenceSet(
  projectId: string,
  userId: string,
): Promise<ReferenceSetSnapshot | null> {
  await assertOwnedProject(projectId, userId);
  const row = await prisma.referenceSet.findFirst({
    where: { projectId, isDefault: true },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    include: referenceSetInclude,
  });
  return row ? toSnapshot(row) : null;
}

export async function createReferenceSet(
  projectId: string,
  userId: string,
  input: {
    name: string;
    description?: string | null;
    assetIds?: string[];
    isDefault?: boolean;
  },
): Promise<ReferenceSetSnapshot> {
  await assertOwnedProject(projectId, userId);
  const name = input.name.trim().slice(0, 80);
  if (!name) {
    throw new ApiError({
      status: 400,
      code: "invalid_request",
      message: "Reference set name is required.",
      retryable: false,
    });
  }
  const assetIds = await filterValidAssetIds(userId, projectId, input.assetIds ?? []);

  return prisma.$transaction(async (tx) => {
    const count = await tx.referenceSet.count({ where: { projectId } });
    if (count >= MAX_REFERENCE_SETS_PER_PROJECT) {
      throw new ApiError({
        status: 409,
        code: "reference_set_limit_reached",
        message: "Reference set limit reached for this project.",
        retryable: false,
      });
    }
    if (input.isDefault) {
      await tx.referenceSet.updateMany({
        where: { projectId, isDefault: true },
        data: { isDefault: false },
      });
    }
    const row = await tx.referenceSet.create({
      data: {
        projectId,
        name,
        description: input.description?.trim().slice(0, 400) || null,
        isDefault: Boolean(input.isDefault),
        assets: {
          create: assetIds.map((assetId, position) => ({ assetId, position })),
        },
      },
      include: referenceSetInclude,
    });
    return toSnapshot(row);
  });
}

export async function updateReferenceSet(
  projectId: string,
  userId: string,
  id: string,
  input: {
    name?: string;
    description?: string | null;
    assetIds?: string[];
    isDefault?: boolean;
  },
): Promise<ReferenceSetSnapshot> {
  await assertOwnedProject(projectId, userId);
  const existing = await prisma.referenceSet.findFirst({
    where: { id, projectId },
    select: { id: true },
  });
  if (!existing) {
    throw new ApiError({
      status: 404,
      code: "reference_set_not_found",
      message: "Reference set not found.",
      retryable: false,
    });
  }

  return prisma.$transaction(async (tx) => {
    if (input.isDefault === true) {
      await tx.referenceSet.updateMany({
        where: { projectId, isDefault: true, NOT: { id } },
        data: { isDefault: false },
      });
    }
    const data: Record<string, unknown> = {};
    if (typeof input.name === "string" && input.name.trim()) data.name = input.name.trim().slice(0, 80);
    if (input.description !== undefined)
      data.description = input.description?.toString().trim().slice(0, 400) || null;
    if (input.isDefault !== undefined) data.isDefault = input.isDefault;

    if (input.assetIds !== undefined) {
      // Replace the ordered membership atomically: drop the old rows and
      // recreate them with fresh positions from the validated id list.
      const validIds = await filterValidAssetIds(userId, projectId, input.assetIds);
      await tx.referenceSetAsset.deleteMany({ where: { referenceSetId: id } });
      if (validIds.length > 0) {
        await tx.referenceSetAsset.createMany({
          data: validIds.map((assetId, position) => ({ referenceSetId: id, assetId, position })),
        });
      }
    }

    const row = await tx.referenceSet.update({ where: { id }, data, include: referenceSetInclude });
    return toSnapshot(row);
  });
}

export async function deleteReferenceSet(
  projectId: string,
  userId: string,
  id: string,
): Promise<void> {
  await assertOwnedProject(projectId, userId);
  // `delete` (not deleteMany) — it raises P2025 when the row is missing, so a
  // bogus or stale id returns a real 404 instead of a silent 204 success.
  await withPrismaNotFound(
    prisma.referenceSet.delete({ where: { id, projectId } }),
    "Reference set not found.",
    "reference_set_not_found",
  );
}

/**
 * Compact text rendering for the agent prompt — only included when a default
 * set with at least one asset exists.
 */
export function renderDefaultReferenceSetForPrompt(set: ReferenceSetSnapshot | null): string | null {
  if (!set || set.assetIds.length === 0) return null;
  const desc = set.description ? ` — ${set.description}` : "";
  return `Default Reference Set "${set.name}"${desc}: ${set.assetIds.length} asset(s) on file.`;
}
