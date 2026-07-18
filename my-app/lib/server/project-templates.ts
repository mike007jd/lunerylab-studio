import "server-only";

import type { Prisma } from "@prisma/client";

import type { TFunction } from "@/lib/i18n/provider";
import {
  resolveTemplateProjectName,
  resolveTemplateSessionTitle,
} from "@/lib/project-name";
import { ApiError } from "@/lib/server/errors";
import { prisma } from "@/lib/server/prisma";

export async function fetchProjectTemplates(userId: string) {
  const templates = await prisma.project.findMany({
    where: { userId, isTemplate: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      name: true,
      templateKey: true,
      _count: { select: { assets: true, canvasSessions: true } },
      assets: {
        where: { deletedAt: null },
        orderBy: { createdAt: "asc" },
        take: 1,
        select: { id: true },
      },
    },
  });
  return templates.map((template) => ({
    id: template.id,
    name: template.name,
    templateKey: template.templateKey,
    previewUrl: template.assets[0] ? `/api/assets/${template.assets[0].id}` : null,
    assetCount: template._count.assets,
    canvasCount: template._count.canvasSessions,
  }));
}

export async function cloneProjectTemplate({
  userId,
  templateId,
  name,
  t,
}: {
  userId: string;
  templateId: string;
  name?: string;
  t: TFunction;
}) {
  const template = await prisma.project.findFirst({
    where: { id: templateId, userId, isTemplate: true },
    include: {
      jobs: true,
      assets: true,
      canvasSessions: { include: { layers: true } },
    },
  });
  if (!template) {
    throw new ApiError({
      status: 404,
      code: "template_not_found",
      message: "Project template not found.",
      retryable: false,
    });
  }

  const localizedProjectName = resolveTemplateProjectName(template, t);

  return prisma.$transaction(async (tx) => {
    const project = await tx.project.create({
      data: {
        userId,
        name: name?.trim() || localizedProjectName,
        category: "STUDIO",
        sourceTemplateId: template.id,
      },
    });

    const jobIds = new Map<string, string>();
    for (const job of template.jobs) {
      const created = await tx.generationJob.create({
        data: {
          userId,
          projectId: project.id,
          source: job.source,
          origin: "TEMPLATE",
          toolType: job.toolType,
          prompt: job.prompt,
          referenceCount: job.referenceCount,
          requestedCount: job.requestedCount,
          successCount: job.successCount,
          status: job.status,
          provider: job.provider,
          model: job.model,
          errorCode: job.errorCode,
          errorMessage: job.errorMessage,
          type: job.type,
          videoDuration: job.videoDuration,
          completedAt: job.completedAt,
        },
      });
      jobIds.set(job.id, created.id);
    }

    const assetIds = new Map<string, string>();
    for (const asset of template.assets) {
      const jobId = jobIds.get(asset.jobId);
      if (!jobId) throw new Error("Template asset has no cloned job.");
      const created = await tx.asset.create({
        data: {
          userId,
          projectId: project.id,
          jobId,
          kind: asset.kind,
          origin: "TEMPLATE",
          modality: asset.modality,
          storagePath: asset.storagePath,
          mimeType: asset.mimeType,
          byteSize: asset.byteSize,
          width: asset.width,
          height: asset.height,
          format: asset.format,
          durationSeconds: asset.durationSeconds,
          tags: asset.tags,
          note: asset.note,
          summary: asset.summary,
        },
      });
      assetIds.set(asset.id, created.id);
    }
    for (const asset of template.assets) {
      if (!asset.parentAssetId) continue;
      const assetId = assetIds.get(asset.id);
      const parentAssetId = assetIds.get(asset.parentAssetId);
      if (assetId && parentAssetId) {
        await tx.asset.update({ where: { id: assetId }, data: { parentAssetId } });
      }
    }

    for (const [sessionIndex, session] of template.canvasSessions.entries()) {
      const createdSession = await tx.canvasSession.create({
        data: {
          userId,
          projectId: project.id,
          title:
            sessionIndex === 0
              ? resolveTemplateSessionTitle(template.templateKey, session.title, t)
              : session.title,
          status: "EDITING",
          zoom: session.zoom,
          panX: session.panX,
          panY: session.panY,
          drawingState: session.drawingState as Prisma.InputJsonValue,
          selectedAssetId: session.selectedAssetId
            ? assetIds.get(session.selectedAssetId) ?? null
            : null,
        },
      });
      for (const layer of session.layers) {
        const assetId = assetIds.get(layer.assetId);
        if (!assetId) continue;
        await tx.canvasLayer.create({
          data: {
            sessionId: createdSession.id,
            assetId,
            x: layer.x,
            y: layer.y,
            width: layer.width,
            height: layer.height,
            rotation: layer.rotation,
            zIndex: layer.zIndex,
            hidden: layer.hidden,
            locked: layer.locked,
          },
        });
      }
    }

    return project;
  });
}
