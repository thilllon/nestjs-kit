import {
  BlobServiceClient,
  StorageSharedKeyCredential,
} from "@azure/storage-blob";
import { Injectable, Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InjectStorageBlob } from "./azure-storage-blob.decorator";
import { AzureStorageBlobModule } from "./azure-storage-blob.module";
import { AzureStorageBlobService } from "./azure-storage-blob.service";

@Injectable()
class Consumer {
  constructor(@InjectStorageBlob() readonly client: BlobServiceClient) {}
}
@Injectable()
class Configuration {
  createModuleOptions() {
    return { connection: "offline" };
  }
}
@Module({ providers: [Configuration], exports: [Configuration] })
class ConfigurationModule {}
afterEach(() => vi.restoreAllMocks());
describe("Azure module", () => {
  it.each([false, true])(
    "exports client injection for consumers (async=%s)",
    async (async) => {
      const client = {} as BlobServiceClient;
      const create = vi
        .spyOn(BlobServiceClient, "fromConnectionString")
        .mockReturnValue(client);
      const options = {
        connection: "offline",
        storageOptions: { retryOptions: { maxTries: 2 } },
      };
      const registration = async
        ? AzureStorageBlobModule.registerAsync({ useFactory: () => options })
        : AzureStorageBlobModule.register(options);
      const module = await Test.createTestingModule({
        imports: [registration],
        providers: [Consumer],
      }).compile();
      expect(module.get(Consumer).client).toBe(client);
      expect(module.get(AzureStorageBlobService).getClient()).toBe(client);
      expect(create).toHaveBeenCalledWith("offline", options.storageOptions);
      expect(
        Reflect.getMetadata("__module:global__", AzureStorageBlobModule),
      ).toBeUndefined();
      await module.close();
    },
  );
  it.each(["class", "existing"] as const)(
    "resolves %s options factories",
    async (mode) => {
      const client = {} as BlobServiceClient;
      vi.spyOn(BlobServiceClient, "fromConnectionString").mockReturnValue(
        client,
      );
      const module = await Test.createTestingModule({
        imports: [
          AzureStorageBlobModule.registerAsync(
            mode === "class"
              ? { useClass: Configuration }
              : { imports: [ConfigurationModule], useExisting: Configuration },
          ),
        ],
        providers: [Consumer],
      }).compile();
      expect(module.get(Consumer).client).toBe(client);
      await module.close();
    },
  );
  it("fails clearly when no connection is supplied", async () => {
    await expect(
      Test.createTestingModule({
        imports: [AzureStorageBlobModule.register({ connection: "" })],
      }).compile(),
    ).rejects.toThrow("NESTJS_STORAGE_BLOB_CONNECTION");
  });
  it("creates upload and download SAS permissions with required upload headers", async () => {
    const generateSasUrl = vi
      .fn()
      .mockResolvedValue("https://example.test/sas");
    const client = {
      getContainerClient: vi.fn().mockReturnValue({
        getBlockBlobClient: vi.fn().mockReturnValue({ generateSasUrl }),
      }),
    };
    const service = new AzureStorageBlobService(
      client as unknown as BlobServiceClient,
    );
    const result = await service.getUploadable("assets", "image.png", 1000);
    expect(result.upload.headers).toEqual({ "x-ms-blob-type": "BlockBlob" });
    expect(
      generateSasUrl.mock.calls.map(([options]) =>
        options.permissions.toString(),
      ),
    ).toEqual(["c", "r"]);
    expect(result.download.method).toBe("GET");
  });
});

describe("Azure SAS generation with the real SDK", () => {
  const service = new AzureStorageBlobService(
    new BlobServiceClient(
      "https://example.blob.core.windows.net",
      new StorageSharedKeyCredential(
        "example",
        Buffer.from("offline-test-key").toString("base64"),
      ),
    ),
  );

  it.each(["blob", "container"] as const)(
    "adds a five-minute expiry to default %s SAS options",
    async (kind) => {
      const now = Date.now();
      const result =
        kind === "blob"
          ? await service.getBlockBlobSasUrl("assets", "file.txt")
          : await service.getContainerSasUrl("assets", { read: true }, {});
      const params = new URL(result.sasUrl).searchParams;
      const expires = new Date(params.get("se") ?? "").getTime();
      expect(expires).toBeGreaterThanOrEqual(now + 299_000);
      expect(expires).toBeLessThanOrEqual(Date.now() + 300_000);
      expect(params.get("sig")).toBeTruthy();
    },
  );

  it.each(["blob", "container"] as const)(
    "preserves explicit %s expiry",
    async (kind) => {
      const expiresOn = new Date("2030-01-01T00:00:00Z");
      const result =
        kind === "blob"
          ? await service.getBlockBlobSasUrl(
              "assets",
              "file.txt",
              { read: true },
              { expiresOn },
            )
          : await service.getContainerSasUrl(
              "assets",
              { read: true },
              { expiresOn },
            );
      expect(
        new Date(new URL(result.sasUrl).searchParams.get("se") ?? ""),
      ).toEqual(expiresOn);
    },
  );

  it.each(["blob", "container"] as const)(
    "keeps expiry controlled by the stored policy for %s SAS",
    async (kind) => {
      const options = { identifier: "read-policy" };
      const result =
        kind === "blob"
          ? await service.getBlockBlobSasUrl(
              "assets",
              "file.txt",
              { read: true },
              options,
            )
          : await service.getContainerSasUrl("assets", { read: true }, options);
      const params = new URL(result.sasUrl).searchParams;
      expect(params.get("si")).toBe("read-policy");
      expect(params.get("se")).toBeNull();
    },
  );
});
