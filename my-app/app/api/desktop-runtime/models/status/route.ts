import { NextResponse } from "next/server";
import { requireDesktopBridge } from "@/lib/server/desktop-bridge";
import { listLocalModelInstallStatuses } from "@/lib/server/local-model-inventory";

export const dynamic = "force-dynamic";

export async function GET() {
  const bridge = requireDesktopBridge();
  if (bridge instanceof NextResponse) return bridge;

  const models = await listLocalModelInstallStatuses();
  return NextResponse.json({ models });
}
