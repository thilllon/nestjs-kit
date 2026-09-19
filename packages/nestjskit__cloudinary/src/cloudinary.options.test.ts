import { Test } from "@nestjs/testing";
import { expect, it } from "vitest";
import * as api from "./index";

it("resolves each registration's own configuration through its public options helper", async () => {
  const firstOptions = {
    cloud_name: "first",
    api_key: "first",
    api_secret: "first",
  };
  const secondOptions = {
    cloud_name: "second",
    api_key: "second",
    api_secret: "second",
  };
  const first = api.CloudinaryModule.register(firstOptions);
  const second = api.CloudinaryModule.registerAsync({
    alias: "second",
    useFactory: async () => secondOptions,
  });
  const probe = Symbol("options probe");
  for (const registration of [first, second]) {
    registration.providers = [
      ...(registration.providers ?? []),
      {
        provide: probe,
        inject: [api.getCloudinaryOptionsToken()],
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
