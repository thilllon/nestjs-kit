# @nestjs-kit/pubnub

[![npm version](https://img.shields.io/npm/v/%40nestjs-kit%2Fpubnub)](https://www.npmjs.com/package/@nestjs-kit/pubnub)
[![npm monthly downloads](https://img.shields.io/npm/dm/%40nestjs-kit%2Fpubnub)](https://www.npmjs.com/package/@nestjs-kit/pubnub)
[![CI](https://img.shields.io/github/actions/workflow/status/thilllon/nestjs-kit/ci.yml?branch=main)](https://github.com/thilllon/nestjs-kit/actions/workflows/ci.yml)

An injectable PubNub client for NestJS. `PubNubService` extends the SDK client, so publishing and subscription APIs remain available.

Install it in your NestJS application:

```sh
pnpm add @nestjs-kit/pubnub pubnub
```

Requires Node.js 24 or newer and NestJS 12. Both ESM and CommonJS are supported.

## Register

```ts
import { Module } from "@nestjs/common";
import { PubNubModule } from "@nestjs-kit/pubnub";

@Module({
  imports: [
    PubNubModule.register({
      userId: "notification-service",
      subscribeKey: process.env.PUBNUB_SUBSCRIBE_KEY!,
      publishKey: process.env.PUBNUB_PUBLISH_KEY!,
    }),
  ],
})
export class NotificationsModule {}
```

Set both key environment variables before starting the application. Use a stable `userId` appropriate to the identity of your application.

## Configure asynchronously

With `@nestjs/config` installed, place this in your module's `imports`:

```ts
import { ConfigModule, ConfigService } from "@nestjs/config";
import { PubNubModule } from "@nestjs-kit/pubnub";

PubNubModule.registerAsync({
  imports: [ConfigModule.forRoot()],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    userId: config.getOrThrow<string>("PUBNUB_USER_ID"),
    subscribeKey: config.getOrThrow<string>("PUBNUB_SUBSCRIBE_KEY"),
    publishKey: config.getOrThrow<string>("PUBNUB_PUBLISH_KEY"),
  }),
});
```

## Multiple clients

Give each registration a unique `alias` and inject the matching client. `alias` and `isGlobal` are Nest module settings: place them beside `useFactory` for async registration, not inside its returned PubNub SDK configuration. For synchronous registration, include them alongside the SDK options in the same object.

```ts
import { Inject, Injectable, Module } from "@nestjs/common";
import {
  getPubNubClientToken,
  PubNubModule,
  PubNubService,
} from "@nestjs-kit/pubnub";

@Injectable()
class AccountNotifications {
  constructor(
    @Inject(getPubNubClientToken("primary")) readonly primary: PubNubService,
    @Inject(getPubNubClientToken("secondary"))
    readonly secondary: PubNubService,
  ) {}
}

@Module({
  imports: [
    PubNubModule.register({
      alias: "primary",
      userId: "primary-notifications",
      subscribeKey: process.env.PRIMARY_SUBSCRIBE_KEY!,
      publishKey: process.env.PRIMARY_PUBLISH_KEY!,
    }),
    PubNubModule.registerAsync({
      alias: "secondary",
      useFactory: () => ({
        userId: "secondary-notifications",
        subscribeKey: process.env.SECONDARY_SUBSCRIBE_KEY!,
        publishKey: process.env.SECONDARY_PUBLISH_KEY!,
      }),
    }),
  ],
  providers: [AccountNotifications],
})
export class MultiAccountModule {}
```

Each registration owns its SDK configuration, client and shutdown hook. SDK options such as `origin` remain available per registration. `getPubNubClientToken(alias)` supports custom provider factories and testing. Named registrations export only their named token; omit `alias` (or use `""` or the reserved `"default"` alias) to retain ordinary `PubNubService` injection. Other aliases are exact, opaque names; use a unique name for each registration. The module stays local unless `isGlobal: true` is requested.

### Major release note

Package-specific injection decorators have been removed; use Nest's `@Inject(getPubNubClientToken(alias))`. Existing single-client `PubNubService` injection continues to work. Applications registering multiple clients should assign distinct aliases and use `@Inject(getPubNubClientToken(alias))` instead of relying on import order to select a class provider.

## Publish a message

Register this service in the module that imports `PubNubModule`:

```ts
import { Injectable } from "@nestjs/common";
import { PubNubService } from "@nestjs-kit/pubnub";

@Injectable()
export class NotificationsService {
  constructor(private readonly pubnub: PubNubService) {}

  notify(channel: string, text: string) {
    return this.pubnub.publish({ channel, message: { text } });
  }
}
```

The module closes its SDK client on destruction. Call `app.enableShutdownHooks()` during Nest bootstrap if shutdown signals should trigger that lifecycle hook.

[Contributing](https://github.com/thilllon/nestjs-kit/blob/main/CONTRIBUTING.md)
