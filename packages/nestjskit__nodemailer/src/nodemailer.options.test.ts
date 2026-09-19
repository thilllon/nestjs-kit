import { Test } from "@nestjs/testing";
import { expect, it } from "vitest";
import * as api from "./index";

it("resolves each registration's own configuration through its public options helper", async () => {
  const firstOptions = {
    transport: { jsonTransport: true },
    defaults: { from: "first@example.com" },
  };
  const secondOptions = {
    transport: { jsonTransport: true },
    defaults: { from: "second@example.com" },
  };
  const first = api.NodemailerModule.register(firstOptions);
  const second = api.NodemailerModule.registerAsync({
    useFactory: async () => secondOptions,
  });
  const probe = Symbol("options probe");
  for (const registration of [first, second]) {
    registration.providers = [
      ...(registration.providers ?? []),
      {
        provide: probe,
        inject: [api.getNodemailerOptionsToken()],
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
