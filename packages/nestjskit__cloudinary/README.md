# @nestjs-kit/cloudinary

[![npm version](https://img.shields.io/npm/v/%40nestjs-kit%2Fcloudinary)](https://www.npmjs.com/package/@nestjs-kit/cloudinary)
[![npm monthly downloads](https://img.shields.io/npm/dm/%40nestjs-kit%2Fcloudinary)](https://www.npmjs.com/package/@nestjs-kit/cloudinary)
[![CI](https://img.shields.io/github/actions/workflow/status/thilllon/nestjs-kit/ci.yml?branch=main)](https://github.com/thilllon/nestjs-kit/actions/workflows/ci.yml)

Cloudinary uploads and upload signatures for NestJS, with optional image resizing through Sharp.

This scoped package is being prepared for its first release. After publication:

```sh
pnpm add @nestjs-kit/cloudinary cloudinary sharp
```

Requires Node.js 24 or newer and NestJS 12. Both ESM and CommonJS are supported.

## Register

```ts
import { Module } from "@nestjs/common";
import { CloudinaryModule } from "@nestjs-kit/cloudinary";

@Module({
  imports: [
    CloudinaryModule.register({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
      global: false,
    }),
  ],
})
export class MediaModule {}
```

Provide all three Cloudinary credentials through your application's configuration. The module is global by default; `global: false` limits its scope. Startup does not make a network health check unless `pingOnInit: true` is set.

## Configure asynchronously

With `@nestjs/config` installed, use this registration in `imports`:

```ts
import { ConfigModule, ConfigService } from "@nestjs/config";
import { CloudinaryModule } from "@nestjs-kit/cloudinary";

CloudinaryModule.registerAsync({
  imports: [ConfigModule.forRoot()],
  inject: [ConfigService],
  global: false,
  useFactory: (config: ConfigService) => ({
    cloud_name: config.getOrThrow<string>("CLOUDINARY_CLOUD_NAME"),
    api_key: config.getOrThrow<string>("CLOUDINARY_API_KEY"),
    api_secret: config.getOrThrow<string>("CLOUDINARY_API_SECRET"),
  }),
});
```

## Sign a direct upload

Register this service in the module that imports `CloudinaryModule`:

```ts
import { Injectable } from "@nestjs/common";
import { CloudinaryService } from "@nestjs-kit/cloudinary";

@Injectable()
export class MediaService {
  constructor(private readonly cloudinary: CloudinaryService) {}

  signUpload(publicId: string) {
    return this.cloudinary.createSignedUploadUrl({
      public_id: publicId,
      resource_type: "image",
      folder: "uploads",
    });
  }
}
```

The result contains the upload URL, timestamp, signature, API key, and upload options. Send those fields with the file to Cloudinary; keep the API secret on the server. Authorize upload requests before issuing signatures.

`uploadFile(file, uploadOptions?, resizeOptions?)` accepts buffered file data. Pass `{ width: 1200 }` as the third argument to resize an image before uploading. `instance` exposes the raw, shared Cloudinary SDK; when using multiple accounts, pass credentials explicitly to raw SDK operations. Wrapper methods use the module's own configuration.

[Contributing](https://github.com/thilllon/nestjs-kit/blob/main/CONTRIBUTING.md)
