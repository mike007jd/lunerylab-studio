import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

describe("Reference Set PGlite concurrency contract", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await db.waitReady;
    const migration = await readFile(
      path.join(
        process.cwd(),
        "prisma",
        "migrations",
        "20260601000000_initial",
        "migration.sql",
      ),
      "utf8",
    );
    await db.exec(migration);
    await db.query(
      `INSERT INTO "User" ("id", "email", "updatedAt")
       VALUES ('user-1', 'owner@example.test', now())`,
    );
    await db.query(
      `INSERT INTO "Project" ("id", "userId", "name", "category", "updatedAt")
       VALUES ('project-1', 'user-1', 'Project', 'STUDIO', now())`,
    );
  });

  beforeEach(async () => {
    await db.query(`DELETE FROM "ReferenceSet"`);
  });

  afterAll(async () => {
    await db.close();
  });

  it("allows only one default when concurrent inserts race", async () => {
    const insertDefault = (id: string) =>
      db.query(
        `INSERT INTO "ReferenceSet"
           ("id", "projectId", "name", "isDefault", "updatedAt")
         VALUES ($1, 'project-1', $1, true, now())`,
        [id],
      );

    const results = await Promise.allSettled([
      insertDefault("default-a"),
      insertDefault("default-b"),
    ]);
    const count = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM "ReferenceSet"
        WHERE "projectId" = 'project-1' AND "isDefault" = true`,
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(count.rows[0]?.count).toBe(1);
  });

  it("serializes the count-and-insert boundary at 24 sets", async () => {
    for (let index = 0; index < 23; index += 1) {
      await db.query(
        `INSERT INTO "ReferenceSet"
           ("id", "projectId", "name", "isDefault", "updatedAt")
         VALUES ($1, 'project-1', $1, false, now())`,
        [`existing-${index}`],
      );
    }

    const createUnderProjectLock = (id: string) =>
      db.transaction(async (tx: Transaction) => {
        await tx.query(
          `SELECT "id" FROM "Project"
            WHERE "id" = 'project-1' AND "userId" = 'user-1'
            FOR UPDATE`,
        );
        const count = await tx.query<{ count: number }>(
          `SELECT count(*)::int AS count
             FROM "ReferenceSet"
            WHERE "projectId" = 'project-1'`,
        );
        if ((count.rows[0]?.count ?? 0) >= 24) {
          throw new Error("reference_set_limit_reached");
        }
        await tx.query(
          `INSERT INTO "ReferenceSet"
             ("id", "projectId", "name", "isDefault", "updatedAt")
           VALUES ($1, 'project-1', $1, false, now())`,
          [id],
        );
      });

    const results = await Promise.allSettled([
      createUnderProjectLock("concurrent-a"),
      createUnderProjectLock("concurrent-b"),
    ]);
    const count = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM "ReferenceSet"
        WHERE "projectId" = 'project-1'`,
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(count.rows[0]?.count).toBe(24);
  });
});
