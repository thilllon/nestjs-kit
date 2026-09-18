import { Test } from "@nestjs/testing";
import { integer, pgTable } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  connections: [] as {
    connect: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
  }[],
  connectError: undefined as Error | undefined,
}));
vi.mock("pg", () => {
  class Connection {
    connect = vi.fn(async () => {
      if (mocks.connectError) throw mocks.connectError;
    });
    end = vi.fn(async () => undefined);
    query = vi.fn(async () => ({ rowCount: 1 }));
    constructor() {
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
  getDrizzlePgServiceToken,
  getDrizzlePgToken,
} from "./drizzle-pg.interface";
import { InjectDrizzlePg } from "./index";
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
    for (const connection of mocks.connections)
      expect(connection.connect).not.toHaveBeenCalled();
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
    for (const connection of mocks.connections)
      expect(connection.end).toHaveBeenCalledOnce();
    expect(InjectDrizzlePg()).toBeTypeOf("function");
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
