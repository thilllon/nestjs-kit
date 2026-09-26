import { describe, expect, it, vi } from "vitest";
import { connectRedisClient, RedisConnection } from "./redis.connection";

describe("RedisConnection", () => {
  it("disconnects once across repeated and concurrent shutdowns", async () => {
    const disconnect = vi.fn(async (_client: string) => undefined);
    const connection = new RedisConnection("client", {
      connect: () => "client",
      disconnect,
    });

    await Promise.all([
      connection.onApplicationShutdown(),
      connection.onApplicationShutdown(),
    ]);
    await connection.onApplicationShutdown();

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledWith("client");
  });

  it("propagates a disconnect failure and retries on the next shutdown", async () => {
    const failure = new Error("quit failed");
    const disconnect = vi
      .fn<(client: string) => Promise<void>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(undefined);
    const connection = new RedisConnection("client", {
      connect: () => "client",
      disconnect,
    });

    await expect(connection.onApplicationShutdown()).rejects.toBe(failure);
    await expect(connection.onApplicationShutdown()).resolves.toBeUndefined();
    expect(disconnect).toHaveBeenCalledTimes(2);
  });
});

describe("connectRedisClient", () => {
  it("rejects a registration without connect or disconnect", async () => {
    await expect(
      connectRedisClient({ connect: () => "client" } as never, "cache"),
    ).rejects.toThrow(
      new TypeError(
        'Redis registration "cache" requires connect and disconnect functions.',
      ),
    );
  });

  it("rejects a connect() that returns no client", async () => {
    await expect(
      connectRedisClient(
        { connect: async () => undefined, disconnect: () => undefined },
        "default",
      ),
    ).rejects.toThrow(
      new TypeError(
        'Redis registration "default" connect() returned no client.',
      ),
    );
  });
});
