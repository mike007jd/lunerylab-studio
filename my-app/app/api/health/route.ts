import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/server/prisma";

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;

    const token = process.env.LUNERY_DESKTOP_SESSION;
    return NextResponse.json({
      ok: true,
      db: "ok",
      ...(token
        ? { session: createHash("sha256").update(token).digest("hex") }
        : {}),
      runtime: {
        primary: "local",
        secondary: "byok",
      },
    });
  } catch (error) {
    // Never leak the raw DB error (it can contain host/connection-string
    // fragments) to this public health endpoint — log it, return a static msg.
    console.error("[health] DB check failed:", error);
    return NextResponse.json(
      {
        ok: false,
        db: "error",
        message: "Database health check failed.",
      },
      { status: 500 }
    );
  }
}
