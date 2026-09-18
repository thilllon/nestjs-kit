import { Injectable, Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { describe, expect, it, vi } from "vitest";
import { S3Module } from "./s3.module";
import type { ModuleOptionsFactory } from "./s3.interface";
import { S3Service } from "./s3.service";
import { getClientToken } from "./s3.utils";

const options = {
  region: async () => "storage-region-1",
  endpoint: "http://localhost:4566",
  forcePathStyle: true,
  credentials: async () => ({
    accessKeyId: "test",
    secretAccessKey: "test",
    sessionToken: "token",
  }),
};
@Injectable()
class Config implements ModuleOptionsFactory {
  create() {
    return options;
  }
}
@Module({ providers: [Config], exports: [Config] })
class ConfigurationModule {}

describe("S3 module", () => {
  it.each(["sync", "factory", "class", "existing"] as const)(
    "forwards SDK options and cleans up (%s)",
    async (mode) => {
      const registration =
        mode === "sync"
          ? S3Module.register(options, { alias: "assets" })
          : S3Module.registerAsync(
              mode === "factory"
                ? { useFactory: async () => options }
                : mode === "class"
                  ? { useClass: Config }
                  : { imports: [ConfigurationModule], useExisting: Config },
              { alias: "assets" },
            );
      const module = await Test.createTestingModule({
        imports: [registration],
      }).compile();
      const client = module.get<S3Service>(getClientToken("assets"));
      expect(client.config.forcePathStyle).toBe(true);
      expect(await client.config.region()).toBe("storage-region-1");
      expect(await client.config.endpoint?.()).toMatchObject({
        hostname: "localhost",
        port: 4566,
      });
      expect(await client.config.credentials()).toMatchObject({
        sessionToken: "token",
      });
      expect(() => module.get(getClientToken())).toThrow();
      const destroy = vi.spyOn(client, "destroy");
      await module.close();
      expect(destroy).toHaveBeenCalledOnce();
    },
  );
  it.each(["us-east-1", "storage-region-1"])(
    "forwards region %s without eager credential resolution",
    async (region) => {
      const module = await Test.createTestingModule({
        imports: [S3Module.register({ region })],
      }).compile();
      const client = module.get<S3Service>(getClientToken());
      expect(await client.config.region()).toBe(region);
      await module.close();
    },
  );
  it("rejects missing asynchronous options factories", () => {
    expect(() => S3Module.registerAsync({})).toThrow("Invalid configuration");
  });
});
