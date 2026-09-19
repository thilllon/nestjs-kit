# @nestjs-kit/cloudinary

[![npm version](https://img.shields.io/npm/v/%40nestjs-kit%2Fcloudinary)](https://www.npmjs.com/package/@nestjs-kit/cloudinary)
[![npm monthly downloads](https://img.shields.io/npm/dm/%40nestjs-kit%2Fcloudinary)](https://www.npmjs.com/package/@nestjs-kit/cloudinary)
[![CI](https://img.shields.io/github/actions/workflow/status/thilllon/nestjs-kit/ci.yml?branch=main)](https://github.com/thilllon/nestjs-kit/actions/workflows/ci.yml)

Cloudinary uploads and upload signatures for NestJS. The adapter streams your buffer to Cloudinary without a local image-processing dependency.

Install it in your NestJS application:

```sh
pnpm add @nestjs-kit/cloudinary cloudinary
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

## Multiple accounts and endpoints

Use a distinct `alias` for each account. `@Inject(getCloudinaryToken(alias))` injects a `CloudinaryService` whose upload, ping and signing operations use that registration's configuration. `alias` and `global` are Nest module settings: declare them beside `useFactory`, not in its returned configuration. The factory returns Cloudinary options and, optionally, the service setting `pingOnInit`. For synchronous registration, include all these settings in the same object.

```ts
import { Inject, Injectable, Module } from "@nestjs/common";
import {
  CloudinaryModule,
  CloudinaryService,
  getCloudinaryToken,
} from "@nestjs-kit/cloudinary";

@Injectable()
class AccountMedia {
  constructor(
    @Inject(getCloudinaryToken("primary")) readonly primary: CloudinaryService,
    @Inject(getCloudinaryToken("regional"))
    readonly regional: CloudinaryService,
  ) {}
}

@Module({
  imports: [
    CloudinaryModule.register({
      alias: "primary",
      global: false,
      cloud_name: process.env.PRIMARY_CLOUD_NAME!,
      api_key: process.env.PRIMARY_API_KEY!,
      api_secret: process.env.PRIMARY_API_SECRET!,
    }),
    CloudinaryModule.registerAsync({
      alias: "regional",
      global: false,
      useFactory: () => ({
        cloud_name: process.env.REGIONAL_CLOUD_NAME!,
        api_key: process.env.REGIONAL_API_KEY!,
        api_secret: process.env.REGIONAL_API_SECRET!,
        upload_prefix: "https://api-eu.cloudinary.com",
      }),
    }),
  ],
  providers: [AccountMedia],
})
export class MultiAccountModule {}
```

Set credentials for both accounts. Use a regional `upload_prefix` only for an account configured for that [Cloudinary data center](https://cloudinary.com/documentation/image_upload_api_reference#eu_or_ap_data_centers_and_endpoints_premium_feature). The configured prefix also determines the direct-upload URL returned by `createSignedUploadUrl()`.

`getCloudinaryToken(alias)` is available for custom providers and testing. Named registrations export only their named service token. Omit `alias` (or use `""` or the reserved `"default"` alias) to preserve ordinary `CloudinaryService` injection. Other aliases are exact, opaque names; use a unique name for each registration. The existing global-by-default behavior remains; use `global: false` for module-local registrations. The adapter opens no persistent client connection to dispose.

## Sign a direct upload

Register this service in the module that imports `CloudinaryModule`:

```ts
import { Inject, Injectable } from "@nestjs/common";
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

## Upload buffered files

`uploadFile(file, uploadOptions?)` sends `file.buffer` unchanged through the Cloudinary SDK. Pass Cloudinary transformations explicitly in the upload options:

```ts
import { Inject, Injectable } from "@nestjs/common";
import { CloudinaryService, type IFile } from "@nestjs-kit/cloudinary";

@Injectable()
export class ImagesService {
  constructor(private readonly cloudinary: CloudinaryService) {}

  upload(file: IFile) {
    return this.cloudinary.uploadFile(file, {
      resource_type: "image",
      transformation: [{ width: 1200, crop: "limit" }],
    });
  }
}
```

Register this provider in a module importing `CloudinaryModule`. These are [Cloudinary incoming transformations](https://cloudinary.com/documentation/eager_and_incoming_transformations): Cloudinary processes the uploaded asset on its servers. Use the SDK's `eager` option to generate additional transformed versions during upload. The original buffer still travels over the network; this does not reduce your application's upload size before transmission.

### Upgrade note

The third `uploadFile()` resize argument and `SharpInputOptions` type have been removed. Remove that argument from existing calls. No resize operation is applied automatically, and the adapter no longer installs or loads Sharp. If you need local preprocessing before upload, perform it in your application using your chosen library and provide the resulting buffer. Use Cloudinary upload transformation options only when server-side processing matches your intended behavior.

### Account configuration and shared SDK state

Every operation requires a registration-local `cloud_name` and either `api_key` plus `api_secret`, or an explicit `oauth_token` for ping/upload. Direct-upload signatures always require a local API key and secret; the existing second `createSignedUploadUrl()` argument can supply the signing secret explicitly. Missing credentials fail before a request is sent. Registration options take precedence over per-upload options. Credentials, OAuth, endpoint, proxy, agent and extra headers must be supplied at registration; per-upload values cannot replace them, even when the registration leaves an optional field unset. Per-upload transformations and other upload-specific options remain supported. This precedence is part of the major release; use another named service to select another account.

The Cloudinary Node SDK has one process-wide configuration object and can silently inherit authentication, endpoints, proxies and other settings from it. This adapter therefore **rejects every nonempty shared SDK configuration at each operation**, including changes made after module registration. Do not call `cloudinary.config({...})` in an application using this adapter. Remove `CLOUDINARY_URL`, `CLOUDINARY_ACCOUNT_URL` and `CLOUDINARY_API_PROXY` from the process environment before importing Cloudinary or starting Nest; these variables initialize SDK-global state. Use separate application environment variables and pass their values explicitly to each registration instead. Restart the process after removing shared configuration: the SDK also captures transport choices when it is first imported, so clearing its config object later is not sufficient.

This is a deliberate compatibility restriction, not a separate SDK instance or automatic cleanup of global state. Even unrelated shared SDK settings are rejected because the SDK may inherit them in current or future operations. Other code in the same process may use the SDK only with explicit call options and an empty shared configuration. If existing application code requires SDK-global configuration, it cannot share this process with these scoped services. The adapter never temporarily changes or resets global settings. Its default API endpoint is explicitly `https://api.cloudinary.com`; signing defaults are explicitly SHA-1 and signature version 2, with per-registration overrides supported.

### Major release upgrade

Package-specific injection decorators have been removed. Import `Inject` from `@nestjs/common` and use `@Inject(getCloudinaryToken(alias))` as shown above. Default `CloudinaryService` class injection remains supported.

### Shared SDK access

The `instance` and `cloudinary` accessors have been removed. They exposed the same process-wide SDK object for every account, so they could not represent an independently configured client. Use `uploadFile()`, `ping()` and `createSignedUploadUrl()` on the injected service. For SDK operations outside this facade, import Cloudinary directly in your application and pass the intended account configuration explicitly on every call; do not mutate shared `cloudinary.config()` state to switch accounts. Existing default `CloudinaryService` injection still works.

[Contributing](https://github.com/thilllon/nestjs-kit/blob/main/CONTRIBUTING.md)
