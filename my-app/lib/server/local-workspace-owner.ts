import { cache } from "react";
import { Prisma } from "@prisma/client";
import { isDesktopRuntime } from "@/lib/desktop-runtime";
import { ApiError } from "@/lib/server/errors";
import { reconcileExternalModelDeleteJournals } from "@/lib/server/imported-model-registry";
import { prisma } from "@/lib/server/prisma";
import { ensureBuiltInProjectTemplates } from "@/lib/server/sample-projects";
import { reconcileStagedStoredFileDeletions } from "@/lib/server/storage";
import { reconcileStagedManagedModelFiles } from "@/lib/server/local-model-files";
import { ensureWorkspaceRestoreReconciled } from "@/lib/server/workspace-restore-journal";

export interface LocalWorkspaceOwner {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

// The single implicit local owner. No accounts, no auth — the desktop app is
// single-user. The UUID is fixed so any pre-existing rows keep resolving.
export const LOCAL_WORKSPACE_OWNER: LocalWorkspaceOwner = {
  id: "00000000-0000-0000-0000-000000000000",
  email: "local@lunerylab.app",
  name: "Local",
  avatarUrl: null,
};

function assertWorkspaceApiAllowed(): void {
  if (isDesktopRuntime()) {
    return;
  }

  throw new ApiError({
    status: 403,
    code: "workspace_api_disabled",
    message: "Workspace APIs are only available inside the desktop runtime.",
    retryable: false,
  });
}

interface LocalWorkspaceOwnerRuntime {
  ensurePromise: Promise<void> | null;
}

const LOCAL_WORKSPACE_OWNER_RUNTIME = "__luneryLocalWorkspaceOwnerRuntimeV1" as const;
const processGlobal = globalThis as typeof globalThis & {
  [LOCAL_WORKSPACE_OWNER_RUNTIME]?: LocalWorkspaceOwnerRuntime;
};
const runtime = processGlobal[LOCAL_WORKSPACE_OWNER_RUNTIME] ?? { ensurePromise: null };
processGlobal[LOCAL_WORKSPACE_OWNER_RUNTIME] = runtime;

// Next can compile callers into separate server bundles. A module-level guard
// is duplicated across those bundles, so concurrent first-boot requests can
// still overlap owner recovery and PGlite template transactions. Keep the
// single-flight on globalThis, beside the other process-wide workspace gates.
export function resetLocalWorkspaceOwnerForTests(): void {
  runtime.ensurePromise = null;
}

async function ensureLocalWorkspaceOwnerOnce(): Promise<void> {
  // Crash recovery must finish before any owner/bootstrap query so workspace
  // APIs never observe a split media/config/DB restore.
  await ensureWorkspaceRestoreReconciled();
  await reconcileExternalModelDeleteJournals();
  await reconcileStagedManagedModelFiles();

  const existing = await prisma.user.findUnique({
    where: { id: LOCAL_WORKSPACE_OWNER.id },
    select: { id: true },
  });
  if (!existing) {
    try {
      await prisma.user.create({
        data: {
          id: LOCAL_WORKSPACE_OWNER.id,
          email: LOCAL_WORKSPACE_OWNER.email,
          name: LOCAL_WORKSPACE_OWNER.name,
          avatarUrl: LOCAL_WORKSPACE_OWNER.avatarUrl,
          settings: {
            create: {
              defaultLocale: "en",
              // No hardcoded defaults — each capability is picked explicitly.
              defaultTextModel: "",
              defaultImageModel: "",
              defaultVideoModel: "",
            },
          },
        },
      });
    } catch (error) {
      // P2002: another process created the fixed local owner first.
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== "P2002"
      ) {
        throw error;
      }
    }
  }

  const referencedFiles = await prisma.asset.findMany({ select: { storagePath: true } });
  await reconcileStagedStoredFileDeletions(
    new Set(referencedFiles.map((asset) => asset.storagePath)),
  );

  await ensureBuiltInProjectTemplates(LOCAL_WORKSPACE_OWNER.id);
}

export const ensureLocalWorkspaceOwner = cache(async (): Promise<void> => {
  if (!runtime.ensurePromise) {
    runtime.ensurePromise = ensureLocalWorkspaceOwnerOnce().catch((err) => {
      // Reset on failure so the next request can retry — without this, a
      // transient first-boot DB hiccup would permanently brick the workspace.
      runtime.ensurePromise = null;
      throw err;
    });
  }
  return runtime.ensurePromise;
});

export async function requireLocalWorkspaceOwner(): Promise<LocalWorkspaceOwner> {
  assertWorkspaceApiAllowed();
  await ensureLocalWorkspaceOwner();
  return LOCAL_WORKSPACE_OWNER;
}

export async function getLocalWorkspacePreferences(ownerId: string) {
  return prisma.userSettings.upsert({
    where: { userId: ownerId },
    update: {},
    create: {
      userId: ownerId,
      defaultLocale: "en",
      defaultTextModel: "",
      defaultImageModel: "",
      defaultVideoModel: "",
    },
  });
}
