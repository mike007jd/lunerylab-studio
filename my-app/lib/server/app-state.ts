import { prisma } from "@/lib/server/prisma";

let warmupPromise: Promise<unknown> | null = null;

// Memoised: idempotent upsert runs at most once per process lifetime. Idle
// generation routes no longer pay the round-trip per request.
export async function ensureAppState() {
  if (!warmupPromise) {
    warmupPromise = prisma.appState
      .upsert({
        where: { id: "singleton" },
        update: {},
        create: { id: "singleton" },
      })
      .catch((error) => {
        warmupPromise = null;
        throw error;
      });
  }
  return warmupPromise;
}
