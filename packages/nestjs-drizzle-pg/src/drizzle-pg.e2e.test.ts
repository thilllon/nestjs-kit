import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Client, type Pool } from "pg";
import { describe, expect, it } from "vitest";
import { DrizzlePgModule } from "./drizzle-pg.module";
import { getDrizzlePgToken } from "./drizzle-pg.interface";
import {
  DrizzlePgService,
  InjectDrizzlePg,
  InjectDrizzlePgService,
  InjectPgConnection,
} from "./index";

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

it("isolates named client and default pool queries, raw injection and shutdown", async () => {
  const defaultName = `drizzle-default-${randomUUID()}`;
  const auditName = `drizzle-audit-${randomUUID()}`;
  @Injectable()
  class Databases {
    constructor(
      @InjectDrizzlePg() readonly defaultDb: NodePgDatabase,
      @InjectDrizzlePg("audit") readonly auditDb: NodePgDatabase,
      @InjectPgConnection() readonly defaultConnection: Pool,
      @InjectPgConnection("audit") readonly auditConnection: Client,
      @InjectDrizzlePgService() readonly defaultService: DrizzlePgService,
      @InjectDrizzlePgService("audit") readonly auditService: DrizzlePgService,
    ) {}
  }
  const observer = new Client(connection);
  let module: TestingModule | undefined;
  const sessions = async (name: string) =>
    (
      await observer.query(
        "select count(*)::int as count from pg_stat_activity where application_name = $1",
        [name],
      )
    ).rows[0].count;
  try {
    await observer.connect();
    module = await Test.createTestingModule({
      imports: [
        DrizzlePgModule.register({
          pgConfig: {
            type: "pool",
            config: { ...connection, application_name: defaultName, max: 1 },
          },
        }),
        DrizzlePgModule.registerAsync({
          alias: "audit",
          useFactory: async () => ({
            pgConfig: {
              type: "client" as const,
              config: { ...connection, application_name: auditName },
            },
          }),
        }),
      ],
      providers: [Databases],
    }).compile();
    await module.init();
    const consumer = module.get(Databases);
    const query = sql`select current_setting('application_name') as name, pg_backend_pid() as pid`;
    const defaultResult = await consumer.defaultDb.execute(query);
    const auditResult = await consumer.auditDb.execute(query);
    expect(defaultResult.rows[0]?.name).toBe(defaultName);
    expect(auditResult.rows[0]?.name).toBe(auditName);
    expect(defaultResult.rows[0]?.pid).not.toBe(auditResult.rows[0]?.pid);
    for (const [raw, result] of [
      [consumer.defaultConnection, defaultResult],
      [consumer.auditConnection, auditResult],
    ] as const) {
      const rawResult = await raw.query(
        "select current_setting('application_name') as name, pg_backend_pid() as pid",
      );
      expect(rawResult.rows).toEqual(result.rows);
    }
    expect(await sessions(defaultName)).toBe(1);
    expect(await sessions(auditName)).toBe(1);
    await consumer.auditService.onModuleDestroy();
    await expect.poll(() => sessions(auditName)).toBe(0);
    expect(await consumer.defaultService.ping()).toBe(true);
    expect(await sessions(defaultName)).toBe(1);
    const closing = module;
    module = undefined;
    await closing.close();
    await expect.poll(() => sessions(defaultName)).toBe(0);
  } finally {
    try {
      await module?.close();
    } finally {
      await observer.end();
    }
  }
});
