import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnModuleDestroy,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { describe, expect, it, vi } from "vitest";
import { RedisModule } from "./redis.module";
import { getRedisToken } from "./redis.tokens";

class FakeClient {
  open = true;

  constructor(readonly name: string) {}

  async quit(): Promise<"OK"> {
    this.open = false;
    return "OK";
  }
}

function fakeRegistration(name: string, log: string[]) {
  return {
    connect: async () => {
      log.push(`connect:${name}`);
      return new FakeClient(name);
    },
    disconnect: async (client: FakeClient) => {
      log.push(`disconnect:${client.name}`);
      await client.quit();
    },
  };
}

describe("RedisModule", () => {
  it("injects isolated default and named clients and disconnects each on close", async () => {
    const log: string[] = [];
    const moduleRef = await Test.createTestingModule({
      imports: [
        RedisModule.register(fakeRegistration("default", log)),
        RedisModule.registerAsync<FakeClient>({
          alias: "cache",
          useFactory: async () => fakeRegistration("cache", log),
        }),
      ],
    }).compile();
    const primary = moduleRef.get<FakeClient>(getRedisToken());
    const cache = moduleRef.get<FakeClient>(getRedisToken("cache"));

    expect([primary.name, cache.name]).toEqual(["default", "cache"]);

    await moduleRef.close();

    expect([primary.open, cache.open]).toEqual([false, false]);
    expect(
      log.filter((entry) => entry.startsWith("disconnect")).sort(),
    ).toEqual(["disconnect:cache", "disconnect:default"]);
  });

  it("keeps clients open for consumer destroy and pre-shutdown hooks", async () => {
    const observed: boolean[] = [];

    @Injectable()
    class Consumer implements OnModuleDestroy, BeforeApplicationShutdown {
      constructor(
        @Inject(getRedisToken()) private readonly client: FakeClient,
      ) {}

      onModuleDestroy() {
        observed.push(this.client.open);
      }

      beforeApplicationShutdown() {
        observed.push(this.client.open);
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [RedisModule.register(fakeRegistration("default", []))],
      providers: [Consumer],
    }).compile();
    await moduleRef.close();

    expect(observed).toEqual([true, true]);
  });

  it("fails bootstrap with the connect error", async () => {
    const failure = new Error("connect ECONNREFUSED 127.0.0.1:6379");

    await expect(
      Test.createTestingModule({
        imports: [
          RedisModule.register({
            connect: async () => Promise.reject(failure),
            disconnect: () => undefined,
          }),
        ],
      }).compile(),
    ).rejects.toBe(failure);
  });

  it("fails bootstrap when connect() returns no client", async () => {
    await expect(
      Test.createTestingModule({
        imports: [
          RedisModule.register({
            alias: "cache",
            connect: async () => undefined,
            disconnect: () => undefined,
          }),
        ],
      }).compile(),
    ).rejects.toThrow(
      'Redis registration "cache" connect() returned no client.',
    );
  });

  it("exposes a global named client to modules that do not import it", async () => {
    @Injectable()
    class Reader {
      constructor(
        @Inject(getRedisToken("shared")) readonly client: FakeClient,
      ) {}
    }

    @Module({
      providers: [Reader],
    })
    class FeatureModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [
        RedisModule.register({
          alias: "shared",
          global: true,
          ...fakeRegistration("shared", []),
        }),
        FeatureModule,
      ],
    }).compile();

    expect(moduleRef.get(Reader).client.name).toBe("shared");
    await moduleRef.close();
  });

  it("rejects an alias registered by two modules before any client connects", async () => {
    const log: string[] = [];

    @Module({
      imports: [
        RedisModule.register({
          alias: "cache",
          ...fakeRegistration("first", log),
        }),
      ],
    })
    class FirstModule {}

    @Module({
      imports: [
        RedisModule.registerAsync<FakeClient>({
          alias: "cache",
          useFactory: () => fakeRegistration("second", log),
        }),
      ],
    })
    class SecondModule {}

    await expect(
      Test.createTestingModule({
        imports: [
          RedisModule.register(fakeRegistration("default", log)),
          FirstModule,
          SecondModule,
        ],
      }).compile(),
    ).rejects.toThrow(
      'Redis alias "cache" is registered by more than one RedisModule. Use distinct aliases, or import one registration module wherever the client is shared.',
    );
    expect(log).toEqual([]);
  });

  it("rejects identical registrations of one alias under deep-hash module ids", async () => {
    const connect = vi.fn(() => new FakeClient("default"));
    const registration = () =>
      RedisModule.register({ connect, disconnect: () => undefined });

    await expect(
      Test.createTestingModule(
        { imports: [registration(), registration()] },
        { moduleIdGeneratorAlgorithm: "deep-hash" },
      ).compile(),
    ).rejects.toThrow('Redis alias "default" is registered by more than one');
    expect(connect).not.toHaveBeenCalled();
  });

  it.each(["reference", "deep-hash"] as const)(
    "shares one registration imported by several modules with %s module ids",
    async (moduleIdGeneratorAlgorithm) => {
      const log: string[] = [];
      const shared = RedisModule.register({
        alias: "cache",
        ...fakeRegistration("cache", log),
      });

      @Module({
        imports: [shared],
        providers: [
          {
            provide: "first",
            inject: [getRedisToken("cache")],
            useFactory: (client: FakeClient) => client,
          },
        ],
      })
      class FirstModule {}

      @Module({
        imports: [shared],
        providers: [
          {
            provide: "second",
            inject: [getRedisToken("cache")],
            useFactory: (client: FakeClient) => client,
          },
        ],
      })
      class SecondModule {}

      const moduleRef = await Test.createTestingModule(
        { imports: [FirstModule, SecondModule] },
        { moduleIdGeneratorAlgorithm },
      ).compile();

      expect(moduleRef.get("first")).toBe(moduleRef.get("second"));
      await moduleRef.close();
      expect(log).toEqual(["connect:cache", "disconnect:cache"]);
    },
  );

  it("logs a failed disconnect and retries it on the next close", async () => {
    const failure = new Error("quit failed");
    const logged = vi
      .spyOn(Logger, "error")
      .mockImplementation(() => undefined);
    const disconnect = vi
      .fn<(client: FakeClient) => Promise<void>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(undefined);
    const moduleRef = await Test.createTestingModule({
      imports: [
        RedisModule.register({
          connect: () => new FakeClient("default"),
          disconnect,
        }),
      ],
    }).compile();

    await expect(moduleRef.close()).resolves.toBeUndefined();
    expect(logged).toHaveBeenCalledWith(failure, failure.stack);

    await moduleRef.close();
    expect(disconnect).toHaveBeenCalledTimes(2);
  });

  it("does not disconnect a client that replaces the registration in tests", async () => {
    const logged = vi
      .spyOn(Logger, "error")
      .mockImplementation(() => undefined);
    const log: string[] = [];
    const mock = new FakeClient("mock");
    const moduleRef = await Test.createTestingModule({
      imports: [RedisModule.register(fakeRegistration("default", log))],
    })
      .overrideProvider(getRedisToken())
      .useValue(mock)
      .compile();

    expect(moduleRef.get(getRedisToken())).toBe(mock);
    await moduleRef.close();

    expect(log).toEqual([]);
    expect(mock.open).toBe(true);
    expect(logged).not.toHaveBeenCalled();
  });
});
