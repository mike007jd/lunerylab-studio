import { cache } from "react";
import { Prisma } from "@prisma/client";
import { isDesktopRuntime } from "@/lib/desktop-runtime";
import { ApiError } from "@/lib/server/errors";
import { prisma } from "@/lib/server/prisma";
import { ensureBuiltInProjectTemplates } from "@/lib/server/sample-projects";

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
  if (
    isDesktopRuntime() ||
    process.env.NODE_ENV !== "production" ||
    process.env.ECOM_ENABLE_WEB_WORKSPACE_API === "1"
  ) {
    return;
  }

  throw new ApiError({
    status: 403,
    code: "workspace_api_disabled",
    message: "Workspace APIs are only available inside the desktop runtime.",
    retryable: false,
  });
}

// Module-level guard so the owner-create + template initialization runs once
// per process, even under concurrent first-boot requests. React's `cache()`
// dedupes per-render, but two simultaneous requests get two render trees and
// can both pass the `existing` check before either creates the row — the
// P2002 race below catches that for the User row. The Promise pattern also
// prevents concurrent template initialization in the same process.
let ensurePromise: Promise<void> | null = null;

async function ensureLocalWorkspaceOwnerOnce(): Promise<void> {
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

  await ensureBuiltInProjectTemplates(LOCAL_WORKSPACE_OWNER.id);
}

export const ensureLocalWorkspaceOwner = cache(async (): Promise<void> => {
  if (!ensurePromise) {
    ensurePromise = ensureLocalWorkspaceOwnerOnce().catch((err) => {
      // Reset on failure so the next request can retry — without this, a
      // transient first-boot DB hiccup would permanently brick the workspace.
      ensurePromise = null;
      throw err;
    });
  }
  return ensurePromise;
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
