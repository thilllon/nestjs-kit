# @nestjs-kit/s3

AWS SDK v3 clients through NestJS dependency injection. Supports asynchronous configuration, named clients, and S3-compatible endpoints.

[![CI](https://img.shields.io/github/actions/workflow/status/thilllon/nestjs-kit/ci.yml?branch=main)](https://github.com/thilllon/nestjs-kit/actions/workflows/ci.yml)

This scoped package is being prepared for its first release. After publication, install it in your NestJS application:

```sh
pnpm add @nestjs-kit/s3 @aws-sdk/client-s3
```

## Register and inject

```ts
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Injectable, Module } from "@nestjs/common";
import { AwsS3Module, InjectAwsS3Client } from "@nestjs-kit/s3";

@Injectable()
export class FilesService {
  constructor(@InjectAwsS3Client() private readonly client: S3Client) {}

  download(bucket: string, key: string) {
    return this.client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  }
}

@Module({
  imports: [AwsS3Module.register({ region: "ap-northeast-2" })],
  providers: [FilesService],
  exports: [FilesService],
})
export class FilesModule {}
```

Options follow `S3ClientConfig`, including credential providers, `endpoint`, and `forcePathStyle`. Omit `credentials` to use the SDK's default provider chain.

## Configure asynchronously

Install `@nestjs/config` if you use the following example. Place this registration in your module's `imports`:

```ts
import { ConfigModule, ConfigService } from "@nestjs/config";
import { AwsS3Module } from "@nestjs-kit/s3";

AwsS3Module.registerAsync({
  imports: [ConfigModule.forRoot()],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    region: config.getOrThrow<string>("AWS_REGION"),
  }),
});
```

`registerAsync` also supports `useClass` and `useExisting`; their factory implements `ModuleOptionsFactory.create()`.

## Named clients

Pass `{ alias: 'archive' }` as the second argument to `register` or `registerAsync`, then inject with `@InjectAwsS3Client('archive')`. Use distinct aliases for distinct clients. The same second argument accepts `{ global: true }` when application-wide registration is intended.

[Migration guide](https://github.com/thilllon/nestjs-kit/blob/main/docs/migration.md) · [Contributing](https://github.com/thilllon/nestjs-kit/blob/main/CONTRIBUTING.md)
