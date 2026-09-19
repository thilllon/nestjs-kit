import { Inject, Injectable, Module } from "@nestjs/common";
import type { Client, Pool } from "pg";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Test } from "@nestjs/testing";
import { integer, pgTable } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  connections: [] as {
    config: unknown;
    connect: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
  }[],
  connectError: undefined as Error | undefined,
}));
vi.mock("pg", () => {
  class Connection {
    connect = vi.fn(async () => {
      if (mocks.connectError) {
        throw mocks.connectError;
      }
    });
    end = vi.fn(async () => undefined);
    query = vi.fn(async () => ({ rowCount: 1 }));
    constructor(readonly config: unknown) {
      mocks.connections.push(this);
    }
  }
  return {
    Pool: class extends Connection {},
    Client: class extends Connection {},
  };
});
vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: vi.fn((connection, config) => ({ connection, config })),
}));
import { DrizzlePgModule } from "./drizzle-pg.module";
import { DrizzlePgService } from "./drizzle-pg.service";
import {
  getDrizzlePgToken,
  getDrizzlePgServiceToken,
  getPgConnectionToken,
} from "./index";
beforeEach(() => {
  mocks.connections.length = 0;
  mocks.connectError = undefined;
});
afterEach(() => vi.clearAllMocks());
describe("Drizzle module", () => {
  it.each([false, true])(
    "accepts and forwards a real schema (async=%s)",
    async (async) => {
      const schema = {
        users: pgTable("users", { id: integer("id").primaryKey() }),
      };
      const options = {
        pgConfig: { type: "pool" as const, config: {} },
        drizzleConfig: { schema },
      };
      const registration = async
        ? DrizzlePgModule.registerAsync({ useFactory: () => options })
        : DrizzlePgModule.register(options);
      const module = await Test.createTestingModule({
        imports: [registration],
      }).compile();
      expect(drizzle).toHaveBeenCalledWith(mocks.connections[0], { schema });
      await module.close();
    },
  );

  it("creates lazy pools for independent aliases and closes each once", async () => {
    const module = await Test.createTestingModule({
      imports: [
        DrizzlePgModule.register({ pgConfig: { type: "pool", config: {} } }),
        DrizzlePgModule.register({
          alias: "analytics",
          pgConfig: { type: "pool", config: {} },
        }),
      ],
    }).compile();
    expect(mocks.connections).toHaveLength(2);
    for (const connection of mocks.connections) {
      expect(connection.connect).not.toHaveBeenCalled();
    }
    expect(module.get(getDrizzlePgToken())).not.toBe(
      module.get(getDrizzlePgToken("analytics")),
    );
    expect(await module.get(DrizzlePgService).ping()).toBe(true);
    expect(
      await module
        .get<DrizzlePgService>(getDrizzlePgServiceToken("analytics"))
        .ping(),
    ).toBe(true);
    await module.close();
    for (const connection of mocks.connections) {
      expect(connection.end).toHaveBeenCalledOnce();
    }
  });
  it.each([false, true])(
    "injects independent databases, raw connections and services (async=%s)",
    async (async) => {
      @Module({
        providers: [
          { provide: "PG_CONFIG", useValue: { application_name: "analytics" } },
        ],
        exports: ["PG_CONFIG"],
      })
      class ConfigurationModule {}
      @Injectable()
      class Consumer {
        constructor(
          @Inject(getDrizzlePgToken()) readonly defaultDb: NodePgDatabase,
          @Inject(getDrizzlePgToken("")) readonly emptyAliasDb: NodePgDatabase,
          @Inject(getDrizzlePgToken("default"))
          readonly explicitDefaultDb: NodePgDatabase,
          @Inject(getDrizzlePgToken("analytics"))
          readonly analyticsDb: NodePgDatabase,
          @Inject(getPgConnectionToken()) readonly defaultConnection: Pool,
          @Inject(getPgConnectionToken("analytics"))
          readonly analyticsConnection: Client,
          @Inject(getDrizzlePgServiceToken())
          readonly defaultService: DrizzlePgService,
          @Inject(getDrizzlePgServiceToken("analytics"))
          readonly analyticsService: DrizzlePgService,
        ) {}
      }
      const options = {
        pgConfig: {
          type: "client" as const,
          config: { application_name: "analytics" },
        },
        drizzleConfig: { logger: false },
      };
      const module = await Test.createTestingModule({
        imports: [
          DrizzlePgModule.register({
            alias: "",
            pgConfig: {
              type: "pool",
              config: { application_name: "default", max: 1 },
            },
          }),
          async
            ? DrizzlePgModule.registerAsync({
                alias: "analytics",
                imports: [ConfigurationModule],
                inject: ["PG_CONFIG"],
                useFactory: async (config: { application_name: string }) => ({
                  ...options,
                  pgConfig: { type: "client" as const, config },
                }),
              })
            : DrizzlePgModule.register({ alias: "analytics", ...options }),
        ],
        providers: [Consumer],
      }).compile();
      const consumer = module.get(Consumer);
      expect(consumer.defaultDb).toBe(consumer.emptyAliasDb);
      expect(consumer.defaultDb).toBe(consumer.explicitDefaultDb);
      expect(consumer.analyticsDb).not.toBe(consumer.defaultDb);
      expect(consumer.defaultConnection).toBe(
        module.get(getPgConnectionToken("default")),
      );
      expect(consumer.defaultConnection).toBe(
        module.get(getPgConnectionToken("")),
      );
      expect(consumer.analyticsConnection).toBe(
        module.get(getPgConnectionToken("analytics")),
      );
      expect(consumer.analyticsConnection).not.toBe(consumer.defaultConnection);
      expect(consumer.defaultService).toBe(module.get(DrizzlePgService));
      expect(consumer.defaultService).toBe(
        module.get(getDrizzlePgServiceToken("")),
      );
      expect(consumer.analyticsService).toBe(
        module.get(getDrizzlePgServiceToken("analytics")),
      );
      expect(mocks.connections.map((connection) => connection.config)).toEqual(
        expect.arrayContaining([
          { application_name: "default", max: 1 },
          { application_name: "analytics" },
        ]),
      );
      expect(drizzle).toHaveBeenCalledWith(consumer.analyticsConnection, {
        logger: false,
      });
      expect(consumer.defaultConnection.connect).not.toHaveBeenCalled();
      expect(consumer.analyticsConnection.connect).toHaveBeenCalledOnce();
      await consumer.analyticsService.onModuleDestroy();
      expect(consumer.analyticsConnection.end).toHaveBeenCalledOnce();
      expect(consumer.defaultConnection.end).not.toHaveBeenCalled();
      expect(await consumer.defaultService.ping()).toBe(true);
      await module.close();
      expect(consumer.defaultConnection.end).toHaveBeenCalledOnce();
      expect(consumer.analyticsConnection.end).toHaveBeenCalledOnce();
    },
  );

  it("shares concurrent shutdown and retries a failed close", async () => {
    const module = await Test.createTestingModule({
      imports: [
        DrizzlePgModule.register({ pgConfig: { type: "pool", config: {} } }),
      ],
    }).compile();
    const service = module.get(DrizzlePgService);
    const connection = mocks.connections[0]!;
    connection.end.mockRejectedValueOnce(new Error("close failed"));
    const first = service.onModuleDestroy();
    expect(service.onModuleDestroy()).toBe(first);
    await expect(first).rejects.toThrow("close failed");
    await service.onModuleDestroy();
    await module.close();
    expect(connection.end).toHaveBeenCalledTimes(2);
  });

  it("supports asynchronous client registration and closes the connection", async () => {
    const module = await Test.createTestingModule({
      imports: [
        DrizzlePgModule.registerAsync({
          useFactory: async () => ({
            pgConfig: { type: "client" as const, config: {} },
          }),
        }),
      ],
    }).compile();
    expect(mocks.connections[0]?.connect).toHaveBeenCalledOnce();
    mocks.connections[0]?.query.mockRejectedValueOnce(new Error("offline"));
    expect(await module.get(DrizzlePgService).ping()).toBe(false);
    await module.close();
    expect(mocks.connections[0]?.end).toHaveBeenCalledOnce();
  });
  it("cleans up a client that fails during connection", async () => {
    mocks.connectError = new Error("connect failed");
    await expect(
      Test.createTestingModule({
        imports: [DrizzlePgModule.register({})],
      }).compile(),
    ).rejects.toThrow("connect failed");
    expect(mocks.connections[0]?.end).toHaveBeenCalledOnce();
  });
});
