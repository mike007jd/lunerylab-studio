import { promises as fs } from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/server/prisma";
import {
  deleteStoredFile,
  restoreStoredFile,
  writeGeneratedImage,
} from "@/lib/server/storage";
import { normalizeLocale } from "@/lib/i18n/locale";
import { getPlainT } from "@/lib/i18n/plain";
import { withSharedMutationLease } from "@/lib/server/workspace-operation-gate";
import {
  SAMPLE_PROJECTS,
  SAMPLE_SOURCE_MIME_TYPE,
  type SampleProjectDef,
} from "@/lib/sample-data";

type SampleTranslator = ReturnType<typeof getPlainT>;

// Public asset root for bundled sample images. The desktop shell injects
// LUNERY_PUBLIC_DIR (lib.rs) so seeding never depends on the server's cwd; for
// `next dev` and tests we fall back to `<cwd>/public`.
function publicAssetRoot() {
  return process.env.LUNERY_PUBLIC_DIR || path.resolve(process.cwd(), "public");
}

function resolvePublicSamplePath(sourcePath: string) {
  const root = publicAssetRoot();

  switch (sourcePath) {
    case "showcase/demo-ref-girl.webp":
      return path.join(root, "showcase", "demo-ref-girl.webp");
    case "showcase/demo-ref-moon.webp":
      return path.join(root, "showcase", "demo-ref-moon.webp");
    case "showcase/demo-stylize-ink.webp":
      return path.join(root, "showcase", "demo-stylize-ink.webp");
    case "showcase/demo-stylize-source.webp":
      return path.join(root, "showcase", "demo-stylize-source.webp");
    case "showcase/demo-stylize-oil.webp":
      return path.join(root, "showcase", "demo-stylize-oil.webp");
    case "showcase/demo-stylize-abstract.webp":
      return path.join(root, "showcase", "demo-stylize-abstract.webp");
    case "samples/coffee-scene.webp":
      return path.join(root, "samples", "coffee-scene.webp");
    case "samples/ceramic-vase.webp":
      return path.join(root, "samples", "ceramic-vase.webp");
    default:
      throw new Error(`sample seed: invalid public asset path ${sourcePath}`);
  }
}

async function copySampleImageToStorage(sourceFilename: string) {
  const sourcePath = resolvePublicSamplePath(sourceFilename);
  const bytes = await fs.readFile(sourcePath);
  return writeGeneratedImage({ bytes });
}

interface RestorableSampleAsset {
  storagePath: string;
  mimeType: string | null;
  byteSize: number | null;
  job: {
    provider: string | null;
    model: string | null;
  } | null;
}

const sampleSourcePaths = SAMPLE_PROJECTS.flatMap((def) =>
  def.layers.map((layer) => layer.source),
);

export async function restoreBundledSampleAssetStorage(
  asset: RestorableSampleAsset,
): Promise<boolean> {
  if (
    asset.job?.provider !== "sample" ||
    asset.mimeType !== SAMPLE_SOURCE_MIME_TYPE ||
    !asset.byteSize
  ) {
    return false;
  }

  for (const source of sampleSourcePaths) {
    const bytes = await fs.readFile(resolvePublicSamplePath(source));
    if (bytes.byteLength !== asset.byteSize) continue;
    await restoreStoredFile({
      storagePath: asset.storagePath,
      bytes,
      mimeType: SAMPLE_SOURCE_MIME_TYPE,
    });
    return true;
  }

  return false;
}

async function seedOneSample(userId: string, def: SampleProjectDef, t: SampleTranslator) {
  return withSharedMutationLease(async () => {
  const projectName = t(`samples.${def.id}.projectName`);
  const jobPrompt = t(`samples.${def.id}.jobPrompt`);
  const sessionTitle = t(`samples.${def.id}.sessionTitle`);
  // The storage write has to land before the Asset row (since the row
  // references the storagePath), so we cannot move it inside the tx. To avoid
  // orphan files on rollback, clean up the just-written files if the tx
  // throws — the success path leaves them in place.
  const copied = await Promise.all(
    def.layers.map((layer) => copySampleImageToStorage(layer.source))
  );

  try {
    await prisma.$transaction(async (tx) => {
      const project = await tx.project.create({
        data: {
          userId,
          name: projectName,
          category: "STUDIO",
          isTemplate: true,
          templateKey: def.id,
        },
        select: { id: true },
      });

      const job = await tx.generationJob.create({
        data: {
          userId,
          projectId: project.id,
          source: "STUDIO",
          origin: "TEMPLATE",
          prompt: jobPrompt,
          referenceCount: 0,
          requestedCount: def.layers.length,
          successCount: def.layers.length,
          status: "SUCCEEDED",
          provider: "sample",
          model: "sample",
          type: "image",
          completedAt: new Date(),
        },
        select: { id: true },
      });

      const assets = await Promise.all(
        copied.map((file) =>
          tx.asset.create({
            data: {
              userId,
              projectId: project.id,
              jobId: job.id,
              kind: "GENERATED",
              origin: "TEMPLATE",
              storagePath: file.storagePath,
              mimeType: file.mimeType,
              byteSize: file.byteSize,
              width: file.width,
              height: file.height,
            },
            select: { id: true },
          })
        )
      );

      const session = await tx.canvasSession.create({
        data: {
          userId,
          projectId: project.id,
          title: sessionTitle,
          status: "EDITING",
          zoom: 0.6,
          panX: 0,
          panY: 0,
          selectedAssetId: assets[0]?.id ?? null,
        },
        select: { id: true },
      });

      await tx.canvasLayer.createMany({
        data: def.layers.map((layer, index) => {
          const asset = assets[index];
          if (!asset) throw new Error("sample seed: asset/layer index mismatch");
          return {
            sessionId: session.id,
            assetId: asset.id,
            x: layer.x,
            y: layer.y,
            width: layer.width,
            height: layer.height,
            rotation: 0,
            zIndex: index,
          };
        }),
      });
    });
  } catch (error) {
    await Promise.allSettled(
      copied.map((file) => deleteStoredFile(file.storagePath)),
    );
    throw error;
  }
  });
}

/**
 * Ensure every bundled project template exists for the local workspace.
 *
 * Existing templates are left untouched and missing templates are restored,
 * including for workspaces created by an older app build. Each template runs
 * in its own transaction, and failures never block application startup.
 */
export async function ensureBuiltInProjectTemplates(userId: string): Promise<void> {
  try {
    // Read the profile locale directly. Calling resolveLocale() here would
    // recurse through ensureLocalWorkspaceOwner() while its first-boot promise
    // is still pending and deadlock the desktop shell before the first render.
    const preferences = await prisma.userSettings.findUnique({
      where: { userId },
      select: { defaultLocale: true },
    });
    const t = getPlainT(normalizeLocale(preferences?.defaultLocale) ?? "en");

    const existingTemplateKeys = new Set(
      (await prisma.project.findMany({
        where: { userId, isTemplate: true, templateKey: { not: null } },
        select: { templateKey: true },
      })).flatMap((project) => project.templateKey ? [project.templateKey] : []),
    );
    const results = await Promise.allSettled(
      SAMPLE_PROJECTS
        .filter((def) => !existingTemplateKeys.has(def.id))
        .map((def) => seedOneSample(userId, def, t)),
    );
    for (const result of results) {
      if (result.status === "rejected") {
        console.error("[sample_project_seed_failed]", { userId, error: result.reason });
      }
    }

  } catch (error) {
    console.error("[project_template_seed_failed]", { userId, error });
  }
}
