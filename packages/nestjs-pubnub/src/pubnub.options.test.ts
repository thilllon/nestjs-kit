import { Test } from "@nestjs/testing";
import { expect, it } from "vitest";
import * as api from "./index";

it("resolves each registration's own configuration through its public options helper", async () => {
  const firstOptions = { userId: "first", subscribeKey: "first" };
  const secondOptions = { userId: "second", subscribeKey: "second" };
  const first = api.PubNubModule.register({ ...firstOptions, global: true });
  const second = api.PubNubModule.registerAsync({
    alias: "second",
    useFactory: async () => secondOptions,
  });
  expect(first.global).toBe(true);
  const probe = Symbol("options probe");
  for (const registration of [first, second]) {
    registration.providers = [
      ...(registration.providers ?? []),
      {
        provide: probe,
        inject: [api.getPubNubOptionsToken()],
        useFactory: (options: unknown) => options,
      },
    ];
  }
  const module = await Test.createTestingModule({
    imports: [first, second],
  }).compile();
  expect(module.select(first).get(probe, { strict: true })).toEqual(
    firstOptions,
  );
  expect(module.select(second).get(probe, { strict: true })).toEqual(
    secondOptions,
  );
  expect(api).not.toHaveProperty("MODULE_OPTIONS_TOKEN");
  await module.close();
});
