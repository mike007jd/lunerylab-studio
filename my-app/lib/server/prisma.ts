import { Prisma, PrismaClient } from "@prisma/client";
import {
  hasWorkspaceMutationAuthority,
  withSharedMutationLease,
} from "@/lib/server/workspace-operation-gate";

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

const READ_OPERATIONS = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
]);

const LEASED_CLIENT_MUTATIONS = new Set([
  "$transaction",
  "$executeRaw",
  "$executeRawUnsafe",
  // Raw "query" SQL can still contain data-changing statements. Treat it as
  // mutation-capable at the admission boundary instead of trying to parse SQL.
  "$queryRaw",
  "$queryRawUnsafe",
]);

function leasePrismaClientMutations<T extends object>(client: T): T {
  return new Proxy(client, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (
        typeof property === "string"
        && LEASED_CLIENT_MUTATIONS.has(property)
        && typeof value === "function"
      ) {
        return (...args: unknown[]) => {
          const invoke = () => Reflect.apply(value, target, args) as Promise<unknown>;
          return hasWorkspaceMutationAuthority()
            ? invoke()
            : withSharedMutationLease(invoke);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

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

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
  prismaBase?: PrismaClient;
};

function createPrismaClient(): PrismaClient {
  const base =
    globalForPrisma.prismaBase ??
    new PrismaClient({
      log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
      ...(datasourceUrl ? { datasourceUrl } : {}),
    });
  globalForPrisma.prismaBase = base;

  // Central admission: mutating model queries cannot escape the shared/exclusive
  // lease. Exclusive restore/reconcile work already holds authority in ALS.
  const extended = base.$extends({
    query: {
      $allModels: {
        async $allOperations({ operation, args, query }) {
          if (READ_OPERATIONS.has(operation) || hasWorkspaceMutationAuthority()) {
            return query(args);
          }
          return withSharedMutationLease(() => query(args));
        },
      },
    },
  });

  // Hold one lease across the entire interactive/batch transaction, including
  // raw SQL. Per-model query interception alone would leave gaps between
  // statements and cannot observe transaction-client `$executeRaw` calls.
  return leasePrismaClientMutations(extended) as unknown as PrismaClient;
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

globalForPrisma.prisma = prisma;
