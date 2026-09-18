import { Injectable } from "@nestjs/common";
import { InjectPubNubClient, getPubNubClientToken } from "./pubnub.tokens";
import { Test } from "@nestjs/testing";
import { describe, expect, it, vi } from "vitest";
import { PubNubModule } from "./pubnub.module";
import { PubNubService } from "./pubnub.service";

describe("PubNub module", () => {
  it.each([false, true])(
    "constructs and destroys client offline (async=%s)",
    async (async) => {
      const options = {
        userId: "offline-user",
        subscribeKey: "offline",
        publishKey: "offline",
      };
      const registration = async
        ? PubNubModule.registerAsync({ useFactory: () => options })
        : PubNubModule.register(options);
      const module = await Test.createTestingModule({
        imports: [registration],
      }).compile();
      const client = module.get(PubNubService);
      expect(client.getUserId()).toBe("offline-user");
      const destroy = vi.spyOn(client, "destroy");
      await module.close();
      expect(destroy).toHaveBeenCalledOnce();
    },
  );
});

it.each([false, true])(
  "injects two named clients independently (first async=%s)",
  async (firstAsync) => {
    @Injectable()
    class Consumer {
      constructor(
        @InjectPubNubClient("first") readonly first: PubNubService,
        @InjectPubNubClient("second") readonly second: PubNubService,
      ) {}
    }
    const register = (alias: string, async: boolean) => {
      const options = {
        userId: alias,
        subscribeKey: `${alias}-subscribe`,
        publishKey: `${alias}-publish`,
        origin: `${alias}.example.com`,
      };
      return async
        ? PubNubModule.registerAsync({ alias, useFactory: async () => options })
        : PubNubModule.register({ ...options, alias });
    };
    const module = await Test.createTestingModule({
      imports: [register("first", firstAsync), register("second", !firstAsync)],
      providers: [Consumer],
    }).compile();
    const { first, second } = module.get(Consumer);
    expect(first).not.toBe(second);
    expect(first).toBe(module.get(getPubNubClientToken("first")));
    expect(second).toBe(module.get(getPubNubClientToken("second")));
    expect(first.getUserId()).toBe("first");
    expect(second.getUserId()).toBe("second");
    first.setUserId("changed-first");
    expect(second.getUserId()).toBe("second");
    const firstDestroy = vi.spyOn(first, "destroy");
    const secondDestroy = vi.spyOn(second, "destroy");
    await module.close();
    expect(firstDestroy).toHaveBeenCalledOnce();
    expect(secondDestroy).toHaveBeenCalledOnce();
  },
);
