# @nestjs-kit/pubnub

An injectable PubNub client for NestJS. `PubNubService` extends the SDK client, so publishing and subscription APIs remain available.

[![CI](https://img.shields.io/github/actions/workflow/status/thilllon/nestjs-kit/ci.yml?branch=main)](https://github.com/thilllon/nestjs-kit/actions/workflows/ci.yml)

This scoped package is being prepared for its first release. After publication:

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
