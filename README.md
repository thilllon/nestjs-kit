# NestJS Kit

Small NestJS modules for storage, media, PostgreSQL, email, and realtime messaging. Register the integration you need, inject it into your service, and keep using the underlying SDK.

[![CI](https://img.shields.io/github/actions/workflow/status/thilllon/nestjs-kit/ci.yml?branch=main&label=CI)](https://github.com/thilllon/nestjs-kit/actions/workflows/ci.yml)
[![License: ISC](https://img.shields.io/badge/license-ISC-blue.svg)](LICENSE)

## Pick an integration

| Package                                                                                      | npm                                                                                                                                                                             | Use it for                                                                 | Guide                                                  |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------ |
| `@nestjs-kit/s3` [(npm)](https://www.npmjs.com/package/@nestjs-kit/s3)                       | [![Monthly downloads for @nestjs-kit/s3](https://img.shields.io/npm/dm/%40nestjs-kit%2Fs3?logo=npm)](https://www.npmjs.com/package/@nestjs-kit/s3)                              | S3-compatible storage clients, including AWS, NetApp, and Ceph             | [README](packages/nestjskit__s3/README.md)             |
| `@nestjs-kit/cloudinary` [(npm)](https://www.npmjs.com/package/@nestjs-kit/cloudinary)       | [![Monthly downloads for @nestjs-kit/cloudinary](https://img.shields.io/npm/dm/%40nestjs-kit%2Fcloudinary?logo=npm)](https://www.npmjs.com/package/@nestjs-kit/cloudinary)      | Signing uploads and uploading media with Cloudinary transformation options | [README](packages/nestjskit__cloudinary/README.md)     |
| `@nestjs-kit/pubnub` [(npm)](https://www.npmjs.com/package/@nestjs-kit/pubnub)               | [![Monthly downloads for @nestjs-kit/pubnub](https://img.shields.io/npm/dm/%40nestjs-kit%2Fpubnub?logo=npm)](https://www.npmjs.com/package/@nestjs-kit/pubnub)                  | Publishing and subscribing through an injectable PubNub client             | [README](packages/nestjskit__pubnub/README.md)         |
| `nestjs-azure-storage-blob` [(npm)](https://www.npmjs.com/package/nestjs-azure-storage-blob) | [![Monthly downloads for nestjs-azure-storage-blob](https://img.shields.io/npm/dm/nestjs-azure-storage-blob?logo=npm)](https://www.npmjs.com/package/nestjs-azure-storage-blob) | Blob storage operations and direct uploads through SAS URLs                | [README](packages/nestjs-azure-storage-blob/README.md) |
| `nestjs-drizzle-pg` [(npm)](https://www.npmjs.com/package/nestjs-drizzle-pg)                 | [![Monthly downloads for nestjs-drizzle-pg](https://img.shields.io/npm/dm/nestjs-drizzle-pg?logo=npm)](https://www.npmjs.com/package/nestjs-drizzle-pg)                         | Drizzle ORM with PostgreSQL pools or clients                               | [README](packages/nestjs-drizzle-pg/README.md)         |
| `nestjs-pg-listen` [(npm)](https://www.npmjs.com/package/nestjs-pg-listen)                   | [![Monthly downloads for nestjs-pg-listen](https://img.shields.io/npm/dm/nestjs-pg-listen?logo=npm)](https://www.npmjs.com/package/nestjs-pg-listen)                            | PostgreSQL LISTEN / NOTIFY with managed subscriber lifecycle               | [README](packages/nestjs-pg-listen/README.md)          |
| `@nestjs-kit/nodemailer` (first release pending)                                             | [![Monthly downloads for @nestjs-kit/nodemailer](https://img.shields.io/npm/dm/%40nestjs-kit%2Fnodemailer?logo=npm)](https://www.npmjs.com/package/@nestjs-kit/nodemailer)      | Email delivery through configurable Nodemailer transports                  | [README](packages/nestjskit__nodemailer/README.md)     |

The six existing integrations are available on npm; Nodemailer is awaiting its first release. Azure and Drizzle keep their existing npm names.

## Quick start

In an existing NestJS application:

```sh
pnpm add @nestjs-kit/s3 @aws-sdk/client-s3
```

```ts
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Injectable, Module } from "@nestjs/common";
import { S3Module, InjectS3Client } from "@nestjs-kit/s3";

@Injectable()
export class FilesService {
  constructor(@InjectS3Client() private readonly s3: S3Client) {}

  download(bucket: string, key: string) {
    return this.s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  }
}

@Module({
  imports: [S3Module.register({ region: "ap-northeast-2" })],
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
