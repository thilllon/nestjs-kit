import { Injectable, Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { describe, expect, it, vi } from "vitest";
import { AwsS3Module } from "./aws-s3.module";
import type { ModuleOptionsFactory } from "./aws-s3.interface";
import { AwsS3Service } from "./aws-s3.service";
import { getClientToken } from "./aws-s3.utils";

const options = {
  region: "us-east-1",
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
          ? AwsS3Module.register(options, { alias: "assets" })
          : AwsS3Module.registerAsync(
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
      const client = module.get<AwsS3Service>(getClientToken("assets"));
      expect(client.config.forcePathStyle).toBe(true);
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
  it("accepts the default credential chain without eager credential resolution", async () => {
    const module = await Test.createTestingModule({
      imports: [AwsS3Module.register({ region: "us-east-1" })],
    }).compile();
    expect(module.get(getClientToken())).toBeInstanceOf(AwsS3Service);
    await module.close();
  });
  it("rejects missing asynchronous options factories", () => {
    expect(() => AwsS3Module.registerAsync({})).toThrow(
      "Invalid configuration",
    );
  });
});
