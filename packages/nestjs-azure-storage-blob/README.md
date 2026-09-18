# nestjs-azure-storage-blob

Azure Blob Storage for NestJS, including SAS URLs for direct browser uploads and access to the underlying Azure client.

[![npm](https://img.shields.io/npm/v/nestjs-azure-storage-blob)](https://www.npmjs.com/package/nestjs-azure-storage-blob)
[![CI](https://img.shields.io/github/actions/workflow/status/thilllon/nestjs-kit/ci.yml?branch=main)](https://github.com/thilllon/nestjs-kit/actions/workflows/ci.yml)

```sh
pnpm add nestjs-azure-storage-blob @azure/storage-blob
```

The npm name remains unchanged. Supply an Azure Storage connection string through your application's configuration.

Requires Node.js 24 or newer and NestJS 12. Both ESM and CommonJS are supported.

## Register

```ts
import { Module } from "@nestjs/common";
import { AzureStorageBlobModule } from "nestjs-azure-storage-blob";

@Module({
  imports: [
    AzureStorageBlobModule.register({
      connection: process.env.AZURE_STORAGE_CONNECTION_STRING!,
    }),
  ],
})
export class StorageModule {}
```

Set `AZURE_STORAGE_CONNECTION_STRING` before startup. Registration fails if the connection string is missing. The optional second argument accepts `{ global: true }` and a Nest provider `scope`.

## Configure asynchronously

With `@nestjs/config` installed, place this registration in `imports`:

```ts
import { ConfigModule, ConfigService } from "@nestjs/config";
import { AzureStorageBlobModule } from "nestjs-azure-storage-blob";

AzureStorageBlobModule.registerAsync({
  imports: [ConfigModule.forRoot()],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    connection: config.getOrThrow<string>("AZURE_STORAGE_CONNECTION_STRING"),
  }),
});
```

`useClass` and `useExisting` factories implement `createModuleOptions()`.

## Issue an upload URL

Register this service in the module that imports `AzureStorageBlobModule`:

```ts
import { Injectable } from "@nestjs/common";
import { AzureStorageBlobService } from "nestjs-azure-storage-blob";

@Injectable()
export class UploadsService {
  constructor(private readonly storage: AzureStorageBlobService) {}

  createUpload(blobName: string) {
    return this.storage.getBlockBlobSasUrl(
      "uploads",
      blobName,
      { create: true, write: true },
      { expiresOn: new Date(Date.now() + 5 * 60 * 1000) },
    );
  }
}
```

Create the container first. An authenticated application endpoint can return this service's `{ sasUrl, headers }` result. Authorize the target blob and issue only the permissions and expiry needed for the operation. Signing these SAS URLs requires a connection string with an account key.

Upload the file bytes from a browser, without wrapping them in `FormData`:

```ts
async function upload(file: File, sasUrl: string) {
  const response = await fetch(sasUrl, {
    method: "PUT",
    headers: { "x-ms-blob-type": "BlockBlob" },
    body: file,
  });
  if (!response.ok) throw new Error(`Upload failed: ${response.status}`);
}
```

Configure Azure Storage CORS for the browser origin, method, and headers. File bytes go directly to Azure rather than through your NestJS server.

## Other operations

- `getClient()`: access the configured `BlobServiceClient`.
- `getContainerSasUrl()` / `getAccountSasUrl()`: create SAS response objects.
- `getUploadable()`: return paired upload and download request details.
- `listFiles(prefix, containerName)`: list blobs with a prefix.
- `deleteFile()` / `deleteFileIfExists()`: remove a blob.
- `downloadStream()`: get the SDK download response.

[Contributing](https://github.com/thilllon/nestjs-kit/blob/main/CONTRIBUTING.md)
