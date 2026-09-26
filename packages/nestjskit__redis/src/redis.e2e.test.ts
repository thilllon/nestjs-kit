import { Test } from "@nestjs/testing";
import { Redis } from "ioredis";
import { Valkey } from "iovalkey";
import { createClient } from "redis";
import { describe, expect, it } from "vitest";
import { RedisModule } from "./redis.module";
import { getRedisToken } from "./redis.tokens";

type NodeRedisClient = ReturnType<typeof createClient>;

const redisUrl = `redis://127.0.0.1:${process.env.REDIS_PORT ?? "56379"}`;
const valkeyUrl = `redis://127.0.0.1:${process.env.VALKEY_PORT ?? "56380"}`;

describe("RedisModule with real clients", () => {
  it("serves ioredis, node-redis and iovalkey registrations and closes them", async () => {
    const key = `nestjs-kit:redis:e2e:${process.pid}`;
    const socketErrors: unknown[] = [];
    const moduleRef = await Test.createTestingModule({
      imports: [
        RedisModule.register({
          connect: () => new Redis(redisUrl),
          disconnect: (client) => client.quit(),
        }),
        RedisModule.register({
          alias: "node",
          connect: () =>
            createClient({ url: redisUrl })
              .on("error", (error: unknown) => {
                socketErrors.push(error);
              })
              .connect(),
          disconnect: (client) => client.close(),
        }),
        RedisModule.registerAsync<Valkey>({
          alias: "valkey",
          useFactory: async () => ({
            connect: () => new Valkey(valkeyUrl),
            disconnect: (client) => client.quit(),
          }),
        }),
      ],
    }).compile();
    const ioredis = moduleRef.get<Redis>(getRedisToken());
    const nodeRedis = moduleRef.get<NodeRedisClient>(getRedisToken("node"));
    const valkey = moduleRef.get<Valkey>(getRedisToken("valkey"));

    try {
      try {
        await ioredis.set(key, "shared");
        expect(await nodeRedis.get(key)).toBe("shared");
        await valkey.set(key, "valkey");
        expect(await valkey.get(key)).toBe("valkey");
        expect(await valkey.info("server")).toMatch(/^valkey_version:/m);
      } finally {
        await Promise.all([ioredis.del(key), valkey.del(key)]);
      }
    } finally {
      await moduleRef.close();
    }

    await expect(ioredis.ping()).rejects.toThrow("Connection is closed");
    expect(nodeRedis.isOpen).toBe(false);
    expect(socketErrors).toEqual([]);
    await expect(valkey.ping()).rejects.toThrow("Connection is closed");
  });

  it("fails bootstrap for an unreachable server with lazyConnect", async () => {
    const url = "redis://127.0.0.1:1";

    await expect(
      Test.createTestingModule({
        imports: [
          RedisModule.register({
            connect: async () => {
              const client = new Redis(url, { lazyConnect: true });
              await client.connect().catch((error: unknown) => {
                client.disconnect();
                throw error;
              });
              return client;
            },
            disconnect: (client) => client.quit(),
          }),
        ],
      }).compile(),
    ).rejects.toThrow("Connection is closed");
  });
});
