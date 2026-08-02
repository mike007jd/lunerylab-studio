import "server-only";

import { prisma } from "@/lib/server/prisma";
import { parseByokModelSelection } from "@/lib/server/byok-shared";
import { getLocalWorkspacePreferences } from "@/lib/server/local-workspace-owner";

export interface ClearedProviderDefaults {
  cleared: Array<"text" | "image" | "video">;
  previous: {
    defaultTextModel: string;
    defaultImageModel: string;
    defaultVideoModel: string;
  };
}

function ownedByProvider(modelId: string, providerId: string): boolean {
  const parsed = parseByokModelSelection(modelId);
  return parsed?.providerId === providerId;
}

/**
 * Clear UserSettings defaults that belong to a provider being unlinked.
 * Only removes text/image/video selections whose `byok:<provider>:<model>`
 * prefix matches the unlinked provider.
 */
export async function clearDefaultsOwnedByProvider(
  userId: string,
  providerId: string,
): Promise<ClearedProviderDefaults> {
  const settings = await getLocalWorkspacePreferences(userId);
  const data: {
    defaultTextModel?: string;
    defaultImageModel?: string;
    defaultVideoModel?: string;
  } = {};
  const cleared: Array<"text" | "image" | "video"> = [];

  if (ownedByProvider(settings.defaultTextModel, providerId)) {
    data.defaultTextModel = "";
    cleared.push("text");
  }
  if (ownedByProvider(settings.defaultImageModel, providerId)) {
    data.defaultImageModel = "";
    cleared.push("image");
  }
  if (ownedByProvider(settings.defaultVideoModel, providerId)) {
    data.defaultVideoModel = "";
    cleared.push("video");
  }

  if (cleared.length > 0) {
    await prisma.userSettings.update({ where: { userId }, data });
  }

  return {
    cleared,
    previous: {
      defaultTextModel: settings.defaultTextModel,
      defaultImageModel: settings.defaultImageModel,
      defaultVideoModel: settings.defaultVideoModel,
    },
  };
}
