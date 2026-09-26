import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Module,
  type OnModuleDestroy,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
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
          isGlobal: true,
          ...fakeRegistration("shared", []),
        }),
        FeatureModule,
      ],
    }).compile();

    expect(moduleRef.get(Reader).client.name).toBe("shared");
    await moduleRef.close();
  });
});
