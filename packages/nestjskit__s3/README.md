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
import { Inject, Injectable, Module } from "@nestjs/common";
import { S3Module, MODULE_CLIENT_TOKEN } from "@nestjs-kit/s3";

@Injectable()
export class FilesService {
  constructor(@Inject(MODULE_CLIENT_TOKEN) private readonly client: S3Client) {}

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

Register the module once per endpoint and give each registration a distinct alias. A single consumer can inject both clients; each keeps its own endpoint, credentials and connection cleanup.

This example uses `@nestjs/config` to load separate credentials for two S3-compatible services:

```ts
import { S3Client } from "@aws-sdk/client-s3";
import { Inject, Injectable, Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { getClientToken, S3Module } from "@nestjs-kit/s3";

@Injectable()
export class StorageService {
  constructor(
    @Inject(getClientToken("primary")) readonly primary: S3Client,
    @Inject(getClientToken("backup")) readonly backup: S3Client,
  ) {}
}

@Module({
  imports: [
    ConfigModule.forRoot(),
    S3Module.registerAsync(
      {
        imports: [ConfigModule],
        inject: [ConfigService],
        useFactory: (config: ConfigService) => ({
          endpoint: config.getOrThrow<string>("PRIMARY_S3_ENDPOINT"),
          region: config.getOrThrow<string>("PRIMARY_S3_REGION"),
          forcePathStyle: true,
          credentials: {
            accessKeyId: config.getOrThrow<string>("PRIMARY_S3_ACCESS_KEY_ID"),
            secretAccessKey: config.getOrThrow<string>(
              "PRIMARY_S3_SECRET_ACCESS_KEY",
            ),
          },
        }),
      },
      { alias: "primary" },
    ),
    S3Module.registerAsync(
      {
        imports: [ConfigModule],
        inject: [ConfigService],
        useFactory: (config: ConfigService) => ({
          endpoint: config.getOrThrow<string>("BACKUP_S3_ENDPOINT"),
          region: config.getOrThrow<string>("BACKUP_S3_REGION"),
          forcePathStyle: true,
          credentials: {
            accessKeyId: config.getOrThrow<string>("BACKUP_S3_ACCESS_KEY_ID"),
            secretAccessKey: config.getOrThrow<string>(
              "BACKUP_S3_SECRET_ACCESS_KEY",
            ),
          },
        }),
      },
      { alias: "backup" },
    ),
  ],
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
```

The same `{ alias: "primary" }` second argument works with `register(options)` and with `useFactory`, `useClass` or `useExisting` async configuration. Keep the alias outside the factory result: Nest needs it when building injection tokens. Distinct endpoints must use distinct aliases; registering two unnamed clients does not make them independently selectable.

An unnamed registration remains injectable with `@Inject(MODULE_CLIENT_TOKEN)` and can coexist with named clients. The second argument also accepts `{ global: true }`; naming still determines which client is injected. Nest closes each registered client when the application shuts down. Nonempty aliases use an underscore suffix, for example `S3_MODULE_CLIENT_TOKEN_primary`; empty aliases keep the default token. Use the exported helpers for named clients and options rather than constructing token strings yourself. `@Inject(getS3OptionsToken(alias))` injects registration options through the package-specific helper; omit the alias for the default registration.

[Contributing](https://github.com/thilllon/nestjs-kit/blob/main/CONTRIBUTING.md)
