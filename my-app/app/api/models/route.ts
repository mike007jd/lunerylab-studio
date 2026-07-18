import { NextResponse } from "next/server";
import { jsonError } from "@/lib/server/errors";
import { getModelCatalog } from "@/lib/server/model-catalog";

export async function GET() {
  try {
    const catalog = await getModelCatalog();
    return NextResponse.json(catalog);
  } catch (error) {
    return jsonError(error);
  }
}
