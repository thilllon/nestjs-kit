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
