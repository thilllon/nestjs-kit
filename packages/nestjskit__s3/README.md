# @nestjs-kit/s3

[![npm version](https://img.shields.io/npm/v/%40nestjs-kit%2Fs3)](https://www.npmjs.com/package/@nestjs-kit/s3)
[![npm monthly downloads](https://img.shields.io/npm/dm/%40nestjs-kit%2Fs3)](https://www.npmjs.com/package/@nestjs-kit/s3)
[![CI](https://img.shields.io/github/actions/workflow/status/thilllon/nestjs-kit/ci.yml?branch=main)](https://github.com/thilllon/nestjs-kit/actions/workflows/ci.yml)

S3-compatible object storage through NestJS dependency injection, using AWS SDK v3 clients. Connect to AWS S3 or S3-compatible endpoints such as NetApp and Ceph with asynchronous configuration and named clients.

Install it in your NestJS application:

```sh
pnpm add @nestjs-kit/s3 @aws-sdk/client-s3
```

Requires Node.js 24 or newer and NestJS 12. Both ESM and CommonJS are supported.

## Register and inject

```ts
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Injectable, Module } from "@nestjs/common";
import { S3Module, InjectS3Client } from "@nestjs-kit/s3";

@Injectable()
export class FilesService {
  constructor(@InjectS3Client() private readonly client: S3Client) {}

  download(bucket: string, key: string) {
    return this.client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  }
}

@Module({
  imports: [S3Module.register({ region: "ap-northeast-2" })],
  providers: [FilesService],
  exports: [FilesService],
})
export class FilesModule {}
```

Options follow `S3ClientConfig`, including credential providers, `endpoint`, and `forcePathStyle`. Omit `credentials` to use the SDK's default provider chain.

Known AWS region names provide editor completion. Custom region strings and the SDK's asynchronous region providers remain supported:

```ts
import type { ModuleOptions, S3Region } from "@nestjs-kit/s3";

const region: S3Region = "storage-region-1";
const options = { region } satisfies ModuleOptions;
const dynamicOptions = {
  region: async () => "storage-region-1",
} satisfies ModuleOptions;
```

## Configure asynchronously

Install `@nestjs/config` if you use the following example. Place this registration in your module's `imports`:

```ts
import { ConfigModule, ConfigService } from "@nestjs/config";
import { S3Module } from "@nestjs-kit/s3";

S3Module.registerAsync({
  imports: [ConfigModule.forRoot()],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    region: config.getOrThrow<string>("S3_REGION"),
  }),
});
```

`registerAsync` also supports `useClass` and `useExisting`; their factory implements `ModuleOptionsFactory.create()`.

## S3-compatible endpoints

For NetApp, Ceph, or another S3-compatible service, configure its S3 API endpoint and credentials. Set the signing region to the value expected by your storage service. Enable `forcePathStyle` when the endpoint expects the bucket in the URL path rather than in the hostname.

```ts
import { ConfigModule, ConfigService } from "@nestjs/config";
import { S3Module } from "@nestjs-kit/s3";

S3Module.registerAsync({
  imports: [ConfigModule.forRoot()],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    endpoint: config.getOrThrow<string>("S3_ENDPOINT"),
    region: config.getOrThrow<string>("S3_REGION"),
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.getOrThrow<string>("S3_ACCESS_KEY_ID"),
      secretAccessKey: config.getOrThrow<string>("S3_SECRET_ACCESS_KEY"),
    },
  }),
});
```

For example, `S3_ENDPOINT` can be `https://s3.storage.example.com`. Available S3 operations depend on the storage service.

## Named clients

Pass `{ alias: 'archive' }` as the second argument to `register` or `registerAsync`, then inject with `@InjectS3Client('archive')`. Use distinct aliases for distinct clients. The same second argument accepts `{ global: true }` when application-wide registration is intended.

[Contributing](https://github.com/thilllon/nestjs-kit/blob/main/CONTRIBUTING.md)
