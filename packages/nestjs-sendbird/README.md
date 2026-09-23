# nestjs-sendbird

**Sendbird Platform API clients for NestJS.** Register one or more Sendbird applications, inject their typed API groups, and keep each application's host and API token separate.

[![npm version](https://img.shields.io/npm/v/nestjs-sendbird)](https://www.npmjs.com/package/nestjs-sendbird)
[![npm monthly downloads](https://img.shields.io/npm/dm/nestjs-sendbird)](https://www.npmjs.com/package/nestjs-sendbird)
[![CI](https://img.shields.io/github/actions/workflow/status/thilllon/nestjs-kit/ci.yml?branch=main)](https://github.com/thilllon/nestjs-kit/actions/workflows/ci.yml)

## Install

```sh
pnpm add nestjs-sendbird @sendbird/sendbird-platform-sdk-typescript
```

Requires **Node.js 24+**, **NestJS 12**, and **Sendbird Platform SDK 2** (`@sendbird/sendbird-platform-sdk-typescript` 2.1.8 or newer). Ships ESM, CommonJS, and TypeScript declarations. This package wraps Sendbird's server-side Platform API SDK, not the `@sendbird/chat` client SDK.

## Create a user

```ts
import { Injectable, Module } from "@nestjs/common";
import { SendbirdModule, SendbirdService } from "nestjs-sendbird";

@Injectable()
export class ChatUsersService {
  constructor(private readonly sendbird: SendbirdService) {}

  create(userId: string, nickname: string) {
    return this.sendbird.users.createAUser({
      createAUserRequest: { userId, nickname, profileUrl: "" },
    });
  }
}

@Module({
  imports: [
    SendbirdModule.register({
      appId: process.env.SENDBIRD_APP_ID!,
      apiToken: process.env.SENDBIRD_API_TOKEN!,
    }),
  ],
  providers: [ChatUsersService],
  exports: [ChatUsersService],
})
export class ChatModule {}
```

Set the application ID and API token from your Sendbird dashboard in your application environment. Requests go to `https://api-{appId}.sendbird.com`.

`SendbirdService` exposes one SDK API object per Platform API group: `announcements`, `bots`, `groupChannels`, `messages`, `metadata`, `moderation`, `openChannels`, `statistics` and `users`. Their methods take the SDK's request object and resolve to its typed response models.

Registration checks that `appId` contains only letters, digits and hyphens (it becomes part of the API host name). It also checks that `apiToken` is a non-empty string of visible ASCII characters, so a trailing newline from a secret file fails at startup instead of on every request. The error message never includes the token. Registration sends no request to Sendbird.

## API tokens

A request uses the registration's `apiToken` unless the call passes its own `apiToken`, for example a secondary API token:

```ts
// Read the per-call token once at startup and fail if it is missing.
const secondaryToken = process.env.SENDBIRD_SECONDARY_TOKEN;
if (!secondaryToken) {
  throw new Error("SENDBIRD_SECONDARY_TOKEN is not set");
}

// After injecting SendbirdService:
await sendbird.users.viewAUser({ userId: "reader" });
await sendbird.users.viewAUser({ userId: "reader", apiToken: secondaryToken });
```

A per-call token always takes precedence. That includes an empty string: it is sent as-is and Sendbird rejects it. The adapter does not replace it with the registration token. An omitted `apiToken` falls back to the registration token, and so does `undefined` or `null`, because the SDK cannot tell them apart from an omitted token. An unset environment variable therefore sends the registration token, which may be your master token, without any error. Check per-call tokens when you read them, as the example does, rather than passing `process.env.NAME!`.

In SDK 2.1.8, `groupChannels.listChannels()` and `users.listMyGroupChannels()` are exceptions: their request types require `apiToken`, and the SDK rejects a call without it with `RequiredError` before the registration token can apply. Pass a token explicitly to those two methods.

The adapter does not validate per-call tokens. The SDK's HTTP client rejects a token containing control characters, such as a trailing newline, and its error message includes the token, so trim tokens you read from files.

## Asynchronous configuration

Install `@nestjs/config` if you use this example, then place the registration in your module's `imports`:

```ts
import { ConfigModule, ConfigService } from "@nestjs/config";
import { SendbirdModule } from "nestjs-sendbird";

SendbirdModule.registerAsync({
  imports: [ConfigModule.forRoot()],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    appId: config.getOrThrow<string>("SENDBIRD_APP_ID"),
    apiToken: config.getOrThrow<string>("SENDBIRD_API_TOKEN"),
  }),
});
```

`registerAsync()` also accepts `useClass` and `useExisting`. These factories implement `create()` and return `SendbirdModuleOptions` or a promise of it. Set `isGlobal: true` in either registration to make the module global; by default it is local to its importing module.

## Multiple applications

Give each registration a distinct `alias` and inject the matching service:

```ts
import { Inject, Injectable, Module } from "@nestjs/common";
import {
  getSendbirdToken,
  SendbirdModule,
  SendbirdService,
} from "nestjs-sendbird";

@Injectable()
class RegionalChat {
  constructor(
    @Inject(getSendbirdToken("us")) readonly us: SendbirdService,
    @Inject(getSendbirdToken("eu")) readonly eu: SendbirdService,
  ) {}
}

@Module({
  imports: [
    SendbirdModule.register({
      alias: "us",
      appId: process.env.SENDBIRD_US_APP_ID!,
      apiToken: process.env.SENDBIRD_US_API_TOKEN!,
    }),
    SendbirdModule.registerAsync({
      alias: "eu",
      useFactory: () => ({
        appId: process.env.SENDBIRD_EU_APP_ID!,
        apiToken: process.env.SENDBIRD_EU_API_TOKEN!,
      }),
    }),
  ],
  providers: [RegionalChat],
})
export class MultiApplicationModule {}
```

`alias` and `isGlobal` are Nest module settings. For asynchronous registration, place them beside `useFactory`, not inside the options it returns. For synchronous registration, include them in the same object as the Sendbird options.

Each registration has its own application host, API token, SDK configuration and API objects. A named registration exports only its named token, `getSendbirdToken(alias)`. Omit `alias` (or use `""` or the reserved `"default"` alias) to keep ordinary `SendbirdService` injection. Other aliases are exact, opaque names. Registrations injected together need distinct aliases: two registrations with the same alias provide the same token, so a consumer cannot tell which one it receives.

## SDK configuration and access

The optional `configuration` option is passed to the SDK's `createConfiguration()`. Use it to set a custom `baseServer` (such as a proxy or local test server), `httpApi`, `middleware` or `promiseMiddleware`. The adapter controls `authMethods`, so the type does not accept it. The adapter copies arrays before passing them to the SDK, so you can reuse one options object for several registrations. It never modifies the SDK's shared `server1` configuration.

`service.configuration` is the registration's SDK `Configuration`, which every exposed API object uses. SDK methods also accept an optional second `Configuration` argument. That argument replaces the registration's server for one call. Unless it defines its own authentication, the registration token still fills an omitted `apiToken`. To reach another application, use another named registration instead.

Non-2xx responses reject with the SDK's `ApiException`. Its `code` is the HTTP status and its `headers` come from Sendbird's response. Its `body` is Sendbird's unparsed response text, not an object: use `JSON.parse(error.body)` to read Sendbird's own error `code` and `message`. A missing required parameter rejects with the SDK's `RequiredError`, and transport failures reject with the HTTP client's error. The adapter passes these errors through unchanged and does not retry.

## Lifecycle

Registration creates only the SDK configuration and API objects. It opens no connections and sends no requests. The SDK sends each request through Node's shared HTTP agent, so a registration owns nothing to close and the module registers no shutdown hook. If you supply an `httpApi` or HTTP agents that hold resources, close them in your application.

## Local tests without the network

Point `baseServer` at a local HTTP server to exercise the real SDK without Sendbird credentials:

```ts
import { ServerConfiguration } from "@sendbird/sendbird-platform-sdk-typescript";
import { SendbirdModule } from "nestjs-sendbird";

SendbirdModule.register({
  appId: "local",
  apiToken: "test-token",
  configuration: {
    baseServer: new ServerConfiguration("http://127.0.0.1:{port}", {
      port: "4010",
    }),
  },
});
```

Requests keep Sendbird's paths and API token header. You can also pass an `httpApi` built with the SDK's `wrapHttpLibrary()` to answer requests in memory. This package's tests use both methods and need neither credentials nor internet access.

## API

| API                                     | Purpose                                                               |
| --------------------------------------- | --------------------------------------------------------------------- |
| `SendbirdModule.register(options)`      | Register an application ID, API token and optional SDK configuration. |
| `SendbirdModule.registerAsync(options)` | Resolve those options through Nest dependency injection.              |
| `SendbirdService`                       | The default registration's API groups and SDK `configuration`.        |
| `@Inject(getSendbirdToken(alias))`      | Inject the `SendbirdService` of a named registration.                 |
| `SendbirdModuleOptions`                 | Options type: `appId`, `apiToken` and optional SDK `configuration`.   |

## Module options token

`getSendbirdOptionsToken()` returns the configuration token for custom providers inside a registration. It takes no alias because each registration has its own options provider. The options provider is not exported to parent or importing modules. Use this helper only for providers added inside that registration or for tests of that registration. The package entry point does not export the builder's generated token.

[SDK repository](https://github.com/sendbird/sendbird-platform-sdk-typescript) · [Contributing](https://github.com/thilllon/nestjs-kit/blob/main/CONTRIBUTING.md)
