import { BlobServiceClient, BlobSASPermissions } from "@azure/storage-blob";
import { Inject, Injectable, Module, Scope } from "@nestjs/common";
import { ContextIdFactory, REQUEST } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { describe, expect, it, vi } from "vitest";
import {
  AzureStorageBlobModule,
  AzureStorageBlobService,
  getAzureStorageBlobServiceToken,
  getStorageBlobClientToken,
  type ModuleOptions,
} from "./index";

const optionsFor = (account: string): ModuleOptions => ({
  connection: `DefaultEndpointsProtocol=https;AccountName=${account};AccountKey=${Buffer.from(`offline-${account}`).toString("base64")};BlobEndpoint=https://${account}.example.test`,
  containerName: `${account}-assets`,
});

@Injectable()
class FirstConfiguration {
  createModuleOptions() {
    return optionsFor("first");
  }
}
@Injectable()
class SecondConfiguration {
  createModuleOptions() {
    return optionsFor("second");
  }
}
@Module({
  providers: [FirstConfiguration, SecondConfiguration],
  exports: [FirstConfiguration, SecondConfiguration],
})
class ConfigurationModule {}

@Injectable()
class MultipleAccounts {
  constructor(
    @Inject(getStorageBlobClientToken())
    readonly defaultClient: BlobServiceClient,
    readonly defaultService: AzureStorageBlobService,
    @Inject(getStorageBlobClientToken("first"))
    readonly firstClient: BlobServiceClient,
    @Inject(getAzureStorageBlobServiceToken("first"))
    readonly firstService: AzureStorageBlobService,
    @Inject(getStorageBlobClientToken("second"))
    readonly secondClient: BlobServiceClient,
    @Inject(getAzureStorageBlobServiceToken("second"))
    readonly secondService: AzureStorageBlobService,
  ) {}
}

describe("Azure account isolation", () => {
  it("uses per-registration containers while preserving the environment fallback", async () => {
    vi.stubEnv("NESTJS_STORAGE_BLOB_CONTAINER", "legacy-assets");
    try {
      const app = await Test.createTestingModule({
        imports: [
          AzureStorageBlobModule.register({
            connection: optionsFor("default").connection,
          }),
          AzureStorageBlobModule.register(optionsFor("first"), {
            alias: "first",
          }),
        ],
      }).compile();
      try {
        expect(app.get(AzureStorageBlobService).getContainerName()).toBe(
          "legacy-assets",
        );
        expect(
          app
            .get<AzureStorageBlobService>(
              getAzureStorageBlobServiceToken("first"),
            )
            .getContainerName(),
        ).toBe("first-assets");
      } finally {
        await app.close();
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each(["sync", "factory", "class", "existing"] as const)(
    "keeps default and two named %s clients, services and signatures separate",
    async (mode) => {
      const named = (["first", "second"] as const).map((alias) => {
        const options = optionsFor(alias);
        if (mode === "sync") {
          return AzureStorageBlobModule.register(options, { alias });
        }
        if (mode === "factory") {
          return AzureStorageBlobModule.registerAsync(
            { useFactory: async () => options },
            { alias },
          );
        }
        const configuration =
          alias === "first" ? FirstConfiguration : SecondConfiguration;
        return AzureStorageBlobModule.registerAsync(
          mode === "class"
            ? { useClass: configuration }
            : { imports: [ConfigurationModule], useExisting: configuration },
          { alias },
        );
      });
      const app = await Test.createTestingModule({
        imports: [
          AzureStorageBlobModule.register(optionsFor("default")),
          ...named,
        ],
        providers: [MultipleAccounts],
      }).compile();
      try {
        const consumer = app.get(MultipleAccounts);
        const expiresOn = new Date("2030-01-01T00:00:00Z");
        const signatures = new Set<string>();
        for (const [account, client, service] of [
          ["default", consumer.defaultClient, consumer.defaultService],
          ["first", consumer.firstClient, consumer.firstService],
          ["second", consumer.secondClient, consumer.secondService],
        ] as const) {
          expect(service.getClient()).toBe(client);
          expect(service.getContainerName()).toBe(`${account}-assets`);
          const { sasUrl } = await service.getBlockBlobSasUrl(
            "assets",
            "file.txt",
            { read: true },
            { expiresOn },
          );
          const expected = await BlobServiceClient.fromConnectionString(
            optionsFor(account).connection,
          )
            .getContainerClient("assets")
            .getBlockBlobClient("file.txt")
            .generateSasUrl({
              permissions: BlobSASPermissions.from({ read: true }),
              expiresOn,
            });
          expect(sasUrl).toBe(expected);
          expect(new URL(sasUrl).hostname).toBe(`${account}.example.test`);
          signatures.add(new URL(sasUrl).searchParams.get("sig")!);
        }
        expect(signatures.size).toBe(3);
      } finally {
        await app.close();
      }
    },
  );

  it.each(["class", "existing"] as const)(
    "preserves request scope for %s factories and their services",
    async (mode) => {
      @Injectable({ scope: Scope.REQUEST })
      class RequestConfiguration {
        constructor(@Inject(REQUEST) readonly request: { account: string }) {}

        createModuleOptions() {
          return optionsFor(this.request.account);
        }
      }
      @Module({
        providers: [RequestConfiguration],
        exports: [RequestConfiguration],
      })
      class RequestConfigurationModule {}
      const app = await Test.createTestingModule({
        imports: [
          AzureStorageBlobModule.registerAsync(
            mode === "class"
              ? { useClass: RequestConfiguration }
              : {
                  imports: [RequestConfigurationModule],
                  useExisting: RequestConfiguration,
                },
            {
              alias: "tenant",
              ...(mode === "class" ? { scope: Scope.REQUEST } : {}),
            },
          ),
        ],
      }).compile();
      try {
        const contexts = [ContextIdFactory.create(), ContextIdFactory.create()];
        const services: AzureStorageBlobService[] = [];
        for (const [index, context] of contexts.entries()) {
          app.registerRequestByContextId(
            { account: `tenant${index}` },
            context,
          );
          const service = await app.resolve<AzureStorageBlobService>(
            getAzureStorageBlobServiceToken("tenant"),
            context,
          );
          expect(service.getClient()).toBe(
            await app.resolve(getStorageBlobClientToken("tenant"), context),
          );
          expect(service.getContainerName()).toBe(`tenant${index}-assets`);
          expect(service).toBe(
            await app.resolve(
              getAzureStorageBlobServiceToken("tenant"),
              context,
            ),
          );
          services.push(service);
        }
        expect(services[0]).not.toBe(services[1]);
        expect(services[0]?.getClient()).not.toBe(services[1]?.getClient());
      } finally {
        await app.close();
      }
    },
  );
});
