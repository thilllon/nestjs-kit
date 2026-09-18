# nestjs-azure-storage-blob

**Azure Blob Storage for NestJS.** Inject a storage client, issue signed URLs, and let browsers upload directly to Azure.

[![npm version](https://img.shields.io/npm/v/nestjs-azure-storage-blob)](https://www.npmjs.com/package/nestjs-azure-storage-blob)
[![npm downloads](https://img.shields.io/npm/dm/nestjs-azure-storage-blob)](https://www.npmjs.com/package/nestjs-azure-storage-blob)
[![CI](https://img.shields.io/github/actions/workflow/status/thilllon/nestjs-kit/ci.yml?branch=main)](https://github.com/thilllon/nestjs-kit/actions/workflows/ci.yml)

[Quick start](#quick-start) · [Browser uploads](#browser-uploads) · [Configuration](#configuration) · [API reference](#api-reference)

## Install

```sh
pnpm add nestjs-azure-storage-blob @azure/storage-blob
```

Requires **Node.js 24+** and **NestJS 12**. Includes ESM, CommonJS, and TypeScript declarations.

## Quick start

Set `AZURE_STORAGE_CONNECTION_STRING` in your application environment. Register the module and inject `AzureStorageBlobService` into a provider:

```ts
import { Injectable, Module } from "@nestjs/common";
import {
  AzureStorageBlobModule,
  AzureStorageBlobService,
} from "nestjs-azure-storage-blob";

const connection = process.env.AZURE_STORAGE_CONNECTION_STRING;
if (!connection) {
  throw new Error("AZURE_STORAGE_CONNECTION_STRING is required");
}

@Injectable()
export class FilesService {
  constructor(private readonly storage: AzureStorageBlobService) {}

  createUpload(blobName: string) {
    return this.storage.getBlockBlobSasUrl(
      "uploads",
      blobName,
      { create: true },
      { expiresOn: new Date(Date.now() + 5 * 60 * 1000) },
    );
  }
}

@Module({
  imports: [AzureStorageBlobModule.register({ connection })],
  providers: [FilesService],
  exports: [FilesService],
})
export class FilesModule {}
```

Create the `uploads` container before using it. `createUpload()` resolves to `{ sasUrl, headers }`; the URL permits creation of a new blob for five minutes. Add `write: true` when the operation must overwrite an existing blob.

## Browser uploads

Your application issues a short-lived SAS URL; the browser sends the file bytes directly to Azure:

```text
Browser → your authenticated endpoint → { sasUrl, headers }
Browser ─────────── PUT file ─────────→ Azure Blob Storage
```

Return the result of `FilesService.createUpload()` from your own authenticated endpoint after authorizing the blob name. Then pass that result to the browser upload function:

```ts
type UploadTarget = {
  sasUrl: string;
  headers: Record<string, string | number>;
};

async function upload(file: File, target: UploadTarget): Promise<void> {
  const headers = Object.fromEntries(
    Object.entries(target.headers).map(([name, value]) => [
      name,
      String(value),
    ]),
  );

  const response = await fetch(target.sasUrl, {
    method: "PUT",
    headers,
    body: file,
  });

  if (!response.ok) {
    throw new Error(`Upload failed: ${response.status}`);
  }
}
```

Use the returned headers, including `x-ms-blob-type: BlockBlob`, and send the file directly rather than wrapping it in `FormData`. Configure Azure Storage CORS to allow your browser origin, `PUT`, and the request headers.

SAS signing requires a connection string containing an **account key**. Keep that connection string on the server; only send the scoped, expiring SAS URL to the browser.

### Upload and download URLs together

```ts
const transfer = await storage.getUploadable("uploads", "photo.jpg", 300_000);

// transfer.upload:   { method, url, headers, expiresIn }
// transfer.download: { method, url, expiresIn }
```

`expiresIn` is measured in **milliseconds** and defaults to five minutes. The upload URL grants `create`; the download URL grants `read`.

## Configuration

### Asynchronous registration

With `@nestjs/config` installed, add this registration to your module's `imports`:

```ts
import { ConfigModule, ConfigService } from "@nestjs/config";
import { AzureStorageBlobModule } from "nestjs-azure-storage-blob";

AzureStorageBlobModule.registerAsync({
  imports: [ConfigModule.forRoot()],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    connection: config.getOrThrow<string>("AZURE_STORAGE_CONNECTION_STRING"),
    storageOptions: {
      retryOptions: { maxTries: 3 },
    },
  }),
});
```

`registerAsync()` also accepts `useClass` and `useExisting`. Their factory implements `ModuleOptionsFactory.createModuleOptions()` and returns module options or a promise of them.

| Option                              | Purpose                                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `connection`                        | Required Azure Storage connection string.                                                               |
| `storageOptions`                    | Azure SDK `StoragePipelineOptions`, such as retry settings.                                             |
| Second argument: `{ global: true }` | Make the registered module available throughout the application. Global registration is off by default. |
| Second argument: `{ scope }`        | Set the Nest provider scope of the storage client.                                                      |

### Azure SDK access

Use the underlying `BlobServiceClient` for operations outside the helper API, such as container creation:

```ts
import { BlobServiceClient } from "@azure/storage-blob";
import { Injectable } from "@nestjs/common";
import { InjectStorageBlob } from "nestjs-azure-storage-blob";

@Injectable()
export class ContainersService {
  constructor(
    @InjectStorageBlob() private readonly client: BlobServiceClient,
  ) {}

  create(name: string) {
    return this.client.getContainerClient(name).createIfNotExists();
  }
}
```

Register this provider in a module that imports `AzureStorageBlobModule`. You can also obtain the same client through `AzureStorageBlobService.getClient()`.

## API reference

All methods below belong to [`AzureStorageBlobService`](https://github.com/thilllon/nestjs-kit/blob/main/packages/nestjs-azure-storage-blob/src/azure-storage-blob.service.ts). Optional arguments are marked with `?`.

| Method                                                                 | Result                                                                           |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `getBlockBlobSasUrl(container, blob, permissions?, options?)`          | Promise of `{ sasUrl, headers }` for one blob. Includes the upload header.       |
| `getContainerSasUrl(container, permissions?, options?)`                | Promise of `{ sasUrl, headers }` for a container.                                |
| `getAccountSasUrl(expiresOn?, permissions?, resourceTypes?, options?)` | `{ sasUrl, headers }` for account-level access; synchronous.                     |
| `getUploadable(container, blob, expiresIn?)`                           | Promise of paired upload and download request details.                           |
| `listFiles(prefix, container)`                                         | Promise of an array of Azure `BlobItem` objects.                                 |
| `deleteFile(container, blob)`                                          | Delete a blob; returns the SDK response.                                         |
| `deleteFileIfExists(container, blob)`                                  | Delete a blob if present; returns the SDK response.                              |
| `downloadStream(container, blob)`                                      | Promise of the SDK download response, including `readableStreamBody` in Node.js. |
| `getClient()`                                                          | The configured Azure `BlobServiceClient`.                                        |

Blob and container SAS URLs default to a **five-minute expiry** unless you provide `expiresOn` or a stored access policy `identifier`. Blob permissions default to `read` and `create`; container and account permissions default to `read`. Pass explicit permissions for the intended operation.

For a complete list of types and less common helpers, see the [source](https://github.com/thilllon/nestjs-kit/tree/main/packages/nestjs-azure-storage-blob/src).

## Project

[Report an issue](https://github.com/thilllon/nestjs-kit/issues/new/choose) · [Contributing](https://github.com/thilllon/nestjs-kit/blob/main/CONTRIBUTING.md) · [License](https://github.com/thilllon/nestjs-kit/blob/main/LICENSE)
