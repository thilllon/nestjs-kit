import { describe, expect, it, vi } from "vitest";
import type { RedisModuleOptions } from "./redis.interface";
import { connectRedisClient, RedisConnection } from "./redis.connection";

interface Client {
  name: string;
}

async function open(options: RedisModuleOptions<Client>) {
  const client = await connectRedisClient(options, "default");
  return new RedisConnection(client, options);
}

describe("RedisConnection", () => {
  it("disconnects once across repeated and concurrent shutdowns", async () => {
    const client = { name: "client" };
    const disconnect = vi.fn(async (_client: Client) => undefined);
    const connection = await open({ connect: () => client, disconnect });

    await Promise.all([
      connection.onApplicationShutdown(),
      connection.onApplicationShutdown(),
    ]);
    await connection.onApplicationShutdown();

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledWith(client);
  });

  it("propagates a disconnect failure and retries on the next shutdown", async () => {
    const failure = new Error("quit failed");
    const disconnect = vi
      .fn<(client: Client) => Promise<void>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(undefined);
    const connection = await open({
      connect: () => ({ name: "client" }),
      disconnect,
    });

    await expect(connection.onApplicationShutdown()).rejects.toBe(failure);
    await expect(connection.onApplicationShutdown()).resolves.toBeUndefined();
    expect(disconnect).toHaveBeenCalledTimes(2);
  });

  it("does not disconnect a client that connect() did not produce", async () => {
    const disconnect = vi.fn(async (_client: Client) => undefined);
    const connection = new RedisConnection<Client>(
      { name: "double" },
      { connect: () => ({ name: "real" }), disconnect },
    );

    await connection.onApplicationShutdown();

    expect(disconnect).not.toHaveBeenCalled();
  });
});

describe("connectRedisClient", () => {
  it("rejects a registration without connect or disconnect", async () => {
    await expect(
      connectRedisClient({ connect: () => ({}) } as never, "cache"),
    ).rejects.toThrow(
      new TypeError(
        'Redis registration "cache" requires connect and disconnect functions.',
      ),
    );
  });

  it.each([undefined, null, "redis://localhost"])(
    "rejects a connect() that returns %s instead of a client",
    async (value) => {
      await expect(
        connectRedisClient(
          { connect: async () => value, disconnect: () => undefined },
          "default",
        ),
      ).rejects.toThrow(
        new TypeError(
          'Redis registration "default" connect() returned no client.',
        ),
      );
    },
  );
});
