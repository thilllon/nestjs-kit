import { Inject, Injectable, Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { describe, expect, it, vi } from "vitest";
import { S3Module } from "./s3.module";
import type { ModuleOptions, ModuleOptionsFactory } from "./s3.interface";
import { S3Service } from "./s3.service";
import { getClientToken, getS3OptionsToken } from "./s3.utils";
import { MODULE_CLIENT_TOKEN } from "./s3.constants";

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
@Module({
  providers: [Config],
  exports: [Config],
})
class ConfigurationModule {}

const backupOptions = {
  region: "backup-region",
  endpoint: "https://backup.storage.example.com",
  forcePathStyle: true,
  credentials: {
    accessKeyId: "backup-access-key",
    secretAccessKey: "backup-test-secret",
  },
};

@Injectable()
class BackupConfig implements ModuleOptionsFactory {
  create() {
    return backupOptions;
  }
}

@Module({
  providers: [BackupConfig],
  exports: [BackupConfig],
})
class BackupConfigurationModule {}

@Injectable()
class NamedClients {
  constructor(
    @Inject(`${MODULE_CLIENT_TOKEN}_primary`) readonly primary: S3Service,
    @Inject(getClientToken("backup")) readonly backup: S3Service,
    @Inject(getS3OptionsToken("primary"))
    readonly primaryOptions: ModuleOptions,
    @Inject(getS3OptionsToken("backup")) readonly backupOptions: ModuleOptions,
  ) {}
}

@Injectable()
class DefaultAndNamedClients {
  constructor(
    @Inject(MODULE_CLIENT_TOKEN) readonly primary: S3Service,
    @Inject(getClientToken("backup")) readonly backup: S3Service,
  ) {}
}

describe("S3 module", () => {
  it.each(["sync", "factory", "class", "existing"] as const)(
    "isolates named endpoints, credentials and cleanup in one app (%s)",
    async (mode) => {
      const backup =
        mode === "sync"
          ? S3Module.register(backupOptions, { alias: "backup" })
          : S3Module.registerAsync(
              mode === "factory"
                ? { useFactory: async () => backupOptions }
                : mode === "class"
                  ? { useClass: BackupConfig }
                  : {
                      imports: [BackupConfigurationModule],
                      useExisting: BackupConfig,
                    },
              { alias: "backup" },
            );
      const app = await Test.createTestingModule({
        imports: [S3Module.register(options, { alias: "primary" }), backup],
        providers: [NamedClients],
      }).compile();
      const {
        primary,
        backup: secondary,
        primaryOptions,
        backupOptions: secondaryOptions,
      } = app.get(NamedClients);
      const primaryDestroy = vi.spyOn(primary, "destroy");
      const secondaryDestroy = vi.spyOn(secondary, "destroy");
      try {
        expect(primary).not.toBe(secondary);
        expect(primaryOptions).toBe(options);
        expect(secondaryOptions).toBe(backupOptions);
        expect(app.get("S3_MODULE_OPTIONS_TOKEN_primary")).toBe(options);
        expect(app.get("S3_MODULE_OPTIONS_TOKEN_backup")).toBe(backupOptions);
        expect(await primary.config.endpoint?.()).toMatchObject({
          hostname: "localhost",
          port: 4566,
        });
        expect(await secondary.config.endpoint?.()).toMatchObject({
          hostname: "backup.storage.example.com",
          protocol: "https:",
        });
        expect(await primary.config.region()).toBe("storage-region-1");
        expect(await secondary.config.region()).toBe("backup-region");
        expect(await primary.config.credentials()).toMatchObject({
          accessKeyId: "test",
        });
        expect(await secondary.config.credentials()).toMatchObject({
          accessKeyId: "backup-access-key",
        });
        expect(() => app.get(getClientToken())).toThrow();
      } finally {
        await app.close();
      }
      expect(primaryDestroy).toHaveBeenCalledOnce();
      expect(secondaryDestroy).toHaveBeenCalledOnce();
    },
  );

  it("keeps default injection independent of a named global registration", async () => {
    const app = await Test.createTestingModule({
      imports: [
        S3Module.register(options),
        S3Module.registerAsync(
          { useFactory: async () => backupOptions },
          { alias: "backup", global: true },
        ),
      ],
      providers: [DefaultAndNamedClients, S3Service],
    }).compile();
    try {
      const { primary, backup } = app.get(DefaultAndNamedClients);
      expect(app.get(getS3OptionsToken())).toBe(options);
      expect(await app.get(S3Service).config.region()).toBe("storage-region-1");
      expect(primary).not.toBe(backup);
      expect(await primary.config.endpoint?.()).toMatchObject({
        hostname: "localhost",
      });
      expect(await backup.config.endpoint?.()).toMatchObject({
        hostname: "backup.storage.example.com",
      });
    } finally {
      await app.close();
    }
  });

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
