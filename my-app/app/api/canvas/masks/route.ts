import { NextRequest, NextResponse } from "next/server";
import { ApiError, jsonError } from "@/lib/server/errors";
import {
  assertRequestContentLength,
  prepareImageFiles,
} from "@/lib/server/file-validation";
import { getMaxUploadBytesPerFile } from "@/lib/server/env";
import { parseFormData } from "@/lib/server/http-validation";
import { requireLocalWorkspaceOwner } from "@/lib/server/local-workspace-owner";
import { storeTemporaryCanvasMask } from "@/lib/server/canvas-temporary-mask";

const PNG_ONLY = new Set(["image/png"]);

export async function POST(request: NextRequest) {
  try {
    await requireLocalWorkspaceOwner();
    assertRequestContentLength(request.headers, getMaxUploadBytesPerFile() + 64 * 1024);
    const formData = await parseFormData(request);
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) {
      throw new ApiError({
        status: 400,
        code: "invalid_request",
        message: "A non-empty PNG mask is required.",
        retryable: false,
      });
    }
    const [prepared] = await prepareImageFiles([file], {
      maxFiles: 1,
      allowedMimeTypes: PNG_ONLY,
    });
    if (!prepared) {
      throw new ApiError({
        status: 400,
        code: "invalid_request",
        message: "A non-empty PNG mask is required.",
        retryable: false,
      });
    }
    const token = await storeTemporaryCanvasMask(prepared.buffer);
    return NextResponse.json({ mask: { token } });
  } catch (error) {
    return jsonError(error);
  }
}
