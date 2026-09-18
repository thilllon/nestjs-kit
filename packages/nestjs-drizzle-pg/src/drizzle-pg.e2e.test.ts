import { randomUUID } from "node:crypto";
import { Test, type TestingModule } from "@nestjs/testing";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { DrizzlePgModule } from "./drizzle-pg.module";
import { getDrizzlePgToken } from "./drizzle-pg.interface";

const connection = {
  host: "127.0.0.1",
  port: Number(process.env.PGPORT ?? 55432),
  user: "nestjs_kit_test",
  password: "local_test_password",
  database: "nestjs_kit_test",
  connectionTimeoutMillis: 3_000,
  statement_timeout: 3_000,
};

describe("Drizzle PostgreSQL E2E", () => {
  it.each(["pool", "client"] as const)(
    "executes SQL through a %s and releases the database session on shutdown",
    async (type) => {
      const applicationName = `drizzle-e2e-${randomUUID()}`;
      const observer = new Client(connection);
      let module: TestingModule | undefined;
      try {
        await observer.connect();
        module = await Test.createTestingModule({
          imports: [
            DrizzlePgModule.register({
              pgConfig:
                type === "pool"
                  ? {
                      type,
                      config: {
                        ...connection,
                        application_name: applicationName,
                        max: 1,
                      },
                    }
                  : {
                      type,
                      config: {
                        ...connection,
                        application_name: applicationName,
                      },
                    },
            }),
          ],
        }).compile();
        await module.init();
        const db = module.get<NodePgDatabase>(getDrizzlePgToken());
        // With max=1, a startup pool checkout leak makes these queries time out.
        for (const value of ["first", "second"]) {
          const result = await db.execute(sql`select ${value}::text as value`);
          expect(result.rows).toEqual([{ value }]);
        }
        const active = await observer.query(
          "select count(*)::int as count from pg_stat_activity where application_name = $1",
          [applicationName],
        );
        expect(active.rows[0].count).toBe(1);
        const closing = module;
        module = undefined;
        await closing.close();
        await expect
          .poll(async () => {
            const result = await observer.query(
              "select count(*)::int as count from pg_stat_activity where application_name = $1",
              [applicationName],
            );
            return result.rows[0].count;
          })
          .toBe(0);
      } finally {
        try {
          await module?.close();
        } finally {
          await observer.end();
        }
      }
    },
  );
});
