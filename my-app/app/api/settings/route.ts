import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/server/prisma";
import { resolveImageModelEntry, resolveVideoModelEntry } from "@/lib/server/model-catalog";
import { parseByokModelSelection } from "@/lib/server/byok-shared";
import { getProviderStatus } from "@/lib/server/api-keys";
import { getByokConnectionMeta } from "@/lib/server/byok-connection-store";
import { listLocalModelInstallStatuses } from "@/lib/server/local-model-inventory";
import { ApiError, jsonError } from "@/lib/server/errors";
import { parseJsonBody } from "@/lib/server/http-validation";
import { requireLocalWorkspaceOwner, getLocalWorkspacePreferences } from "@/lib/server/local-workspace-owner";
import { withSharedWorkspaceRead } from "@/lib/server/workspace-operation-gate";

const settingsPatchSchema = z
  .object({
    defaultTextModel: z.string().trim().optional(),
    defaultImageModel: z.string().trim().optional(),
    defaultVideoModel: z.string().trim().optional(),
    defaultLocale: z.enum(["en", "zh-CN", "zh-TW"]).optional(),
  })
  .strict();

export async function GET() {
  try {
    const user = await requireLocalWorkspaceOwner();
    return await withSharedWorkspaceRead(async () => {
      const settings = await getLocalWorkspacePreferences(user.id);
      const providers = await getProviderStatus();

      return NextResponse.json({
        app: {
          defaultLocale: settings.defaultLocale,
          defaultTextModel: settings.defaultTextModel,
          defaultImageModel: settings.defaultImageModel,
          defaultVideoModel: settings.defaultVideoModel,
        },
        providers,
      });
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const user = await requireLocalWorkspaceOwner();

    // `parseJsonBody` surfaces the actual validation issues the same way this
    // route established: a 400 `invalid_body` whose `details.fieldErrors` lets
    // the settings UI render inline per-field hints, with the first issue's
    // message in the top-level `message` for plain callers.
    const body = await parseJsonBody(request, settingsPatchSchema);

    const data: {
      defaultTextModel?: string;
      defaultImageModel?: string;
      defaultVideoModel?: string;
      defaultLocale?: string;
    } = {};

    if (body.defaultTextModel !== undefined) {
      if (body.defaultTextModel) {
        const byok = parseByokModelSelection(body.defaultTextModel);
        if (byok) {
          const [providerStatus, connection] = await Promise.all([
            getProviderStatus(),
            Promise.resolve(getByokConnectionMeta(byok.providerId)),
          ]);
          if (
            !providerStatus[byok.providerId]?.configured
            || connection?.models?.text !== byok.modelId
          ) {
            throw new ApiError({
              status: 400,
              code: "invalid_model",
              message: `Text model is not configured for provider: ${byok.providerId}`,
              retryable: false,
            });
          }
        } else if (/^local:[A-Za-z0-9._/-]+$/.test(body.defaultTextModel)) {
          const localId = body.defaultTextModel.slice("local:".length);
          const inventory = await listLocalModelInstallStatuses();
          const installed = inventory.find((model) =>
            model.id === localId
            && model.installed
            && model.capability === "planner-llm");
          if (!installed) {
            throw new ApiError({
              status: 400,
              code: "invalid_model",
              message: `Local text model is not installed: ${localId}`,
              retryable: false,
            });
          }
        } else {
          throw new ApiError({
            status: 400,
            code: "invalid_model",
            message: `Unknown text model selection: ${body.defaultTextModel}`,
            retryable: false,
          });
        }
      }
      data.defaultTextModel = body.defaultTextModel;
    }

    if (body.defaultImageModel !== undefined) {
      if (body.defaultImageModel) {
        const modelEntry = await resolveImageModelEntry(body.defaultImageModel);
        if (!modelEntry) {
          throw new ApiError({
            status: 400,
            code: "invalid_model",
            message: `Unknown model: ${body.defaultImageModel}`,
            retryable: false,
          });
        }
      }
      data.defaultImageModel = body.defaultImageModel;
    }

    if (body.defaultVideoModel !== undefined) {
      if (body.defaultVideoModel) {
        const modelEntry = await resolveVideoModelEntry(body.defaultVideoModel);
        if (!modelEntry) {
          throw new ApiError({
            status: 400,
            code: "invalid_model",
            message: `Unknown video model: ${body.defaultVideoModel}`,
            retryable: false,
          });
        }
      }
      data.defaultVideoModel = body.defaultVideoModel;
    }

    if (body.defaultLocale !== undefined) {
      data.defaultLocale = body.defaultLocale;
    }

    const settings = await prisma.userSettings.update({
      where: { userId: user.id },
      data,
    });
    const providers = await getProviderStatus();

    return NextResponse.json({
      app: {
        defaultLocale: settings.defaultLocale,
        defaultTextModel: settings.defaultTextModel,
        defaultImageModel: settings.defaultImageModel,
        defaultVideoModel: settings.defaultVideoModel,
      },
      providers,
    });
  } catch (error) {
    return jsonError(error);
  }
}
