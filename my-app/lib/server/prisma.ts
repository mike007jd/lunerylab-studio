import { Prisma, PrismaClient } from "@prisma/client";

export const REQUIRED_GENERATION_JOB_FIELDS = ["type", "videoDuration"] as const;

export function assertGenerationJobClientFields(fieldNames: Iterable<string>) {
  const availableFields = new Set(fieldNames);
  const missingFields = REQUIRED_GENERATION_JOB_FIELDS.filter((field) => !availableFields.has(field));

  if (missingFields.length > 0) {
    throw new Error(
      `Loaded Prisma client is stale. GenerationJob is missing fields: ${missingFields.join(", ")}. ` +
        "Run `npm run prisma:generate` and restart the Next.js dev server."
    );
  }
}

function getGenerationJobFieldNames() {
  return (
    Prisma.dmmf.datamodel.models
      .find((model) => model.name === "GenerationJob")
      ?.fields.map((field) => field.name) ?? []
  );
}

export function assertVideoGenerationPrismaSupport() {
  assertGenerationJobClientFields(getGenerationJobFieldNames());
}

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

function resolveDatasourceUrl() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return undefined;

  try {
    const url = new URL(databaseUrl);
    if (!url.searchParams.has("connection_limit")) {
      url.searchParams.set("connection_limit", "1");
    }
    if (!url.searchParams.has("pool_timeout")) {
      url.searchParams.set("pool_timeout", "20");
    }
    return url.toString();
  } catch {
    return databaseUrl;
  }
}

const datasourceUrl = resolveDatasourceUrl();

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
    ...(datasourceUrl ? { datasourceUrl } : {}),
  });

globalForPrisma.prisma = prisma;
