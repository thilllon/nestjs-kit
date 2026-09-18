# NestJS Kit

Small NestJS modules for storage, media, PostgreSQL, and realtime messaging. Register the integration you need, inject it into your service, and keep using the underlying SDK.

[![CI](https://img.shields.io/github/actions/workflow/status/thilllon/nestjs-kit/ci.yml?branch=main&label=CI)](https://github.com/thilllon/nestjs-kit/actions/workflows/ci.yml)
[![Drizzle on npm](https://img.shields.io/npm/v/nestjs-drizzle-pg?label=drizzle%20npm)](https://www.npmjs.com/package/nestjs-drizzle-pg)
[![Azure on npm](https://img.shields.io/npm/v/nestjs-azure-storage-blob?label=azure%20npm)](https://www.npmjs.com/package/nestjs-azure-storage-blob)
[![License: ISC](https://img.shields.io/badge/license-ISC-blue.svg)](LICENSE)

## Pick an integration

| Package                     | Use it for                                                                      | Guide                                                              |
| --------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `@nestjs-kit/s3`            | Injecting AWS SDK v3 clients, including named clients and S3-compatible storage | [S3](packages/nestjskit__s3/README.md)                             |
| `@nestjs-kit/cloudinary`    | Signing uploads and uploading media, with optional image resizing               | [Cloudinary](packages/nestjskit__cloudinary/README.md)             |
| `@nestjs-kit/pubnub`        | Publishing and subscribing through an injectable PubNub client                  | [PubNub](packages/nestjskit__pubnub/README.md)                     |
| `nestjs-azure-storage-blob` | Blob storage operations and direct uploads through SAS URLs                     | [Azure Blob Storage](packages/nestjs-azure-storage-blob/README.md) |
| `nestjs-drizzle-pg`         | Drizzle ORM with PostgreSQL pools or clients                                    | [Drizzle + PostgreSQL](packages/nestjs-drizzle-pg/README.md)       |
| `nestjs-pg-listen`          | PostgreSQL LISTEN / NOTIFY with managed subscriber lifecycle                    | [PostgreSQL notifications](packages/nestjs-pg-listen/README.md)    |

The new `@nestjs-kit/*` packages and `nestjs-pg-listen` are being prepared for their first release. Installation commands below and in their guides apply once published. Azure and Drizzle keep their existing npm names.

## Quick start

In an existing NestJS application:

```sh
pnpm add @nestjs-kit/s3 @aws-sdk/client-s3
```

```ts
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Injectable, Module } from "@nestjs/common";
import { AwsS3Module, InjectAwsS3Client } from "@nestjs-kit/s3";

@Injectable()
export class FilesService {
  constructor(@InjectAwsS3Client() private readonly s3: S3Client) {}

  download(bucket: string, key: string) {
    return this.s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  }
}

@Module({
  imports: [AwsS3Module.register({ region: "ap-northeast-2" })],
  providers: [FilesService],
  exports: [FilesService],
})
export class FilesModule {}
```

AWS credentials use the SDK's default provider chain. Each package guide includes asynchronous configuration for Nest's dependency injection system.

Every library ships separate ESM and CommonJS builds with matching TypeScript declarations. Use normal `import` syntax in ESM or `require()` in CommonJS; package exports select the matching output automatically.

## Develop locally

Install [mise](https://mise.jdx.dev/getting-started.html), then:

```sh
mise trust
mise install
mise exec -- pnpm install
mise exec -- pnpm build
mise exec -- pnpm test
```

`mise.toml` defines the toolchain. Development tracks the latest Node.js LTS (currently 24) and uses a pinned stable pnpm release; pnpm does not publish an LTS channel. Turbo uses streaming output without its terminal UI.

Read [CONTRIBUTING.md](CONTRIBUTING.md) for checks, commit conventions, and pull requests. [Release automation](docs/releases.md) explains independent package versions and the one-time npm setup.

## License

[ISC](LICENSE).
