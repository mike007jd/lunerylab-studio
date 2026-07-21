import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/server/prisma";
import { ApiError, jsonError, withPrismaNotFound } from "@/lib/server/errors";
import { parseJsonBody } from "@/lib/server/http-validation";
import {
  getStoredFileMetadata,
  streamStoredFile,
  type StoredFileMetadata,
} from "@/lib/server/storage";
import { restoreBundledSampleAssetStorage } from "@/lib/server/sample-projects";
import { purgeAssets } from "@/lib/server/asset-purge";
import { toAssetDTO } from "@/lib/server/dto";
import { requireLocalWorkspaceOwner } from "@/lib/server/local-workspace-owner";

interface Params {
  params: Promise<{ id: string }>;
}

// Mirrors the prior `{ tags?: unknown; isFavorite?: unknown; note?: unknown }`
// cast. All three fields stay `unknown` because the handler does its own
// Array.isArray / typeof / null type-narrowing and the "at least one field"
// check below — the schema only enforces an object body (replacing the former
// `if (!body) throw …` rejection; a null/non-object body now fails as the
// standard `invalid_body` 400). Non-strict: unknown keys ignored as before.
const updateAssetBodySchema = z.object({
  tags: z.unknown().optional(),
  isFavorite: z.unknown().optional(),
  note: z.unknown().optional(),
  restore: z.boolean().optional(),
});

function rangeNotSatisfiableResponse(total: number, mimeType: string) {
  return new NextResponse(null, {
    status: 416,
    headers: {
      "Content-Range": `bytes */${total}`,
      "Accept-Ranges": "bytes",
      "Content-Type": mimeType,
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}

function parseVideoRange(range: string, total: number): { start: number; end: number } | null {
  if (total <= 0) {
    return null;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!match) {
    return null;
  }

  const [, startRaw, endRaw] = match;
  if (!startRaw && !endRaw) {
    return null;
  }

  if (!startRaw) {
    const suffixLength = Number(endRaw);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return null;
    }
    return {
      start: Math.max(total - suffixLength, 0),
      end: total - 1,
    };
  }

  const start = Number(startRaw);
  if (!Number.isSafeInteger(start) || start < 0 || start >= total) {
    return null;
  }

  const end = endRaw ? Number(endRaw) : total - 1;
  if (!Number.isSafeInteger(end) || end < start) {
    return null;
  }

  return {
    start,
    end: Math.min(end, total - 1),
  };
}

interface AssetFileRecord {
  storagePath: string;
  mimeType: string | null;
  byteSize: number | null;
  job: {
    provider: string | null;
    model: string | null;
  } | null;
}

async function getAssetMetadataWithSampleRestore(
  asset: AssetFileRecord,
): Promise<StoredFileMetadata> {
  try {
    return await getStoredFileMetadata(asset.storagePath);
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== "stored_file_not_found") {
      throw error;
    }

    const restored = await restoreBundledSampleAssetStorage(asset);
    if (!restored) throw error;
    return getStoredFileMetadata(asset.storagePath);
  }
}

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const user = await requireLocalWorkspaceOwner();
    const { id } = await params;
    const body = await parseJsonBody(request, updateAssetBodySchema);
    const data: Record<string, unknown> = {};
    if (Array.isArray(body.tags)) {
      const cleanTags = body.tags
        .filter((v): v is string => typeof v === "string")
        .map((v) => v.trim())
        .filter((v) => v.length > 0 && v.length <= 40)
        .slice(0, 24);
      // Dedupe (case-insensitive) while preserving first occurrence casing.
      const seen = new Set<string>();
      data.tags = cleanTags.filter((t) => {
        const k = t.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
    if (typeof body.isFavorite === "boolean") {
      data.isFavorite = body.isFavorite;
    }
    if (body.note === null) {
      data.note = null;
    } else if (typeof body.note === "string") {
      data.note = body.note.trim().slice(0, 280) || null;
    }
    if (body.restore === true) {
      data.deletedAt = null;
    }
    if (Object.keys(data).length === 0) {
      throw new ApiError({
        status: 400,
        code: "invalid_request",
        message: "Provide at least one of tags / isFavorite / note / restore.",
        retryable: false,
      });
    }
    // Single round-trip: `update({ where: { id, userId } })` raises P2025 if
    // the row doesn't match, which we translate to 404. The previous
    // updateMany → findUnique pair had a race where a concurrent delete could
    // flip a 200-with-stale-row into a misleading 404.
    const asset = await withPrismaNotFound(
      prisma.asset.update({
        where: { id, userId: user.id },
        data,
      }),
      "Asset not found.",
    );
    return NextResponse.json({ asset: toAssetDTO(asset) });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const user = await requireLocalWorkspaceOwner();
    const { id } = await params;

    // `?permanent=true` hard-deletes the asset (row + file).
    // Without it, DELETE soft-deletes into Trash as before.
    const permanent = new URL(request.url).searchParams.get("permanent") === "true";

    if (permanent) {
      const result = await purgeAssets(user.id, [id]);
      if (result.purgedCount !== 1) {
        throw new ApiError({
          status: 404,
          code: "asset_not_found",
          message: "Asset not found.",
          retryable: false,
        });
      }
      return NextResponse.json({
        deleted: { id },
        permanent: true,
        bytesFreed: result.bytesFreed,
      });
    }

    const deleted = await prisma.asset.updateMany({
      where: { id, userId: user.id, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (deleted.count !== 1) {
      throw new ApiError({
        status: 404,
        code: "asset_not_found",
        message: "Asset not found or already in Trash.",
        retryable: false,
      });
    }

    return NextResponse.json({ deleted: { id } });
  } catch (error) {
    return jsonError(error);
  }
}

export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const user = await requireLocalWorkspaceOwner();
    const { id } = await params;

    const asset = await prisma.asset.findUnique({
      where: { id, userId: user.id },
      select: {
        id: true,
        storagePath: true,
        mimeType: true,
        byteSize: true,
        job: {
          select: {
            provider: true,
            model: true,
          },
        },
      },
    });

    if (!asset) {
      throw new ApiError({
        status: 404,
        code: "asset_not_found",
        message: "Asset not found.",
        retryable: false,
      });
    }

    const metadata = await getAssetMetadataWithSampleRestore(asset);
    const total = metadata.byteSize;
    const mimeType = asset.mimeType || metadata.mimeType;

    const range = _request.headers.get("range");
    if (range && mimeType.startsWith("video/")) {
      const parsedRange = parseVideoRange(range, total);
      if (!parsedRange) {
        return rangeNotSatisfiableResponse(total, mimeType);
      }

      const chunkSize = parsedRange.end - parsedRange.start + 1;
      const { stream } = await streamStoredFile(asset.storagePath, parsedRange);

      return new NextResponse(stream, {
        status: 206,
        headers: {
          "Content-Range": `bytes ${parsedRange.start}-${parsedRange.end}/${total}`,
          "Accept-Ranges": "bytes",
          "Content-Length": String(chunkSize),
          "Content-Type": mimeType,
          "Cache-Control": "private, max-age=31536000, immutable",
        },
      });
    }

    const headers: Record<string, string> = {
      "Content-Type": mimeType,
      "Content-Length": String(total),
      "Cache-Control": "private, max-age=31536000, immutable",
    };

    if (mimeType.startsWith("video/")) {
      headers["Accept-Ranges"] = "bytes";
    }

    const { stream } = await streamStoredFile(asset.storagePath);
    return new NextResponse(stream, { headers });
  } catch (error) {
    return jsonError(error);
  }
}
