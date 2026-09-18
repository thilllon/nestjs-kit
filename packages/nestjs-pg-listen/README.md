# nestjs-pg-listen

[![npm version](https://img.shields.io/npm/v/nestjs-pg-listen)](https://www.npmjs.com/package/nestjs-pg-listen)
[![npm monthly downloads](https://img.shields.io/npm/dm/nestjs-pg-listen)](https://www.npmjs.com/package/nestjs-pg-listen)
[![CI](https://img.shields.io/github/actions/workflow/status/thilllon/nestjs-kit/ci.yml?branch=main)](https://github.com/thilllon/nestjs-kit/actions/workflows/ci.yml)

PostgreSQL LISTEN / NOTIFY for NestJS, powered by [pg-listen](https://github.com/andywer/pg-listen). Inject its typed subscriber while Nest manages connection startup, channel subscriptions, and shutdown.

This package is being prepared for its first release. After publication, install it into your NestJS application:

```sh
pnpm add nestjs-pg-listen pg-listen pg
```

Requires Node.js 24 or newer and NestJS 12. Both ESM and CommonJS are supported.

## Register and receive notifications

```ts
import { Injectable, Module, OnModuleInit } from "@nestjs/common";
import { InjectPgListen, PgListenModule, Subscriber } from "nestjs-pg-listen";

type Events = { orders: { id: string } };

@Injectable()
export class OrdersListener implements OnModuleInit {
  constructor(
    @InjectPgListen() private readonly subscriber: Subscriber<Events>,
  ) {}

  onModuleInit() {
    this.subscriber.notifications.on("orders", ({ id }) => {
      console.log("Order changed:", id);
    });
  }

  notify(id: string) {
    return this.subscriber.notify("orders", { id });
  }
}

@Module({
  imports: [
    PgListenModule.register({
      connection: { connectionString: process.env.DATABASE_URL },
      channels: ["orders"],
      options: { retryTimeout: 10_000 },
    }),
  ],
  providers: [OrdersListener],
})
export class OrdersModule {}
```

Set `DATABASE_URL`, or omit `connection` to use node-postgres environment variables. `connection` accepts `pg.ClientConfig`; `options` accepts pg-listen's reconnect, health-check, and serialization options. Channel names are deduplicated before subscribing.

Register notification listeners in `onModuleInit`. The module connects and subscribes in `onApplicationBootstrap`, after those initialization hooks have run. Send messages after application startup finishes. `notifications.on()` attaches a local handler; `listenTo()` subscribes the database connection, so configure `channels` or explicitly call `listenTo()` for additional channels.

## Async configuration

With `@nestjs/config` installed, use this registration in your module's `imports`:

```ts
import { ConfigModule, ConfigService } from "@nestjs/config";
import { PgListenModule } from "nestjs-pg-listen";

PgListenModule.registerAsync({
  imports: [ConfigModule.forRoot()],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    connection: { connectionString: config.getOrThrow<string>("DATABASE_URL") },
    channels: ["orders"],
  }),
});
```

Both registration methods accept `isGlobal: true` at the top level. Register once per application; named registrations are not provided. The raw subscriber is available via `@InjectPgListen()`, the `PG_LISTEN_SUBSCRIBER` token, or `PgListenService.subscriber`.

## Errors and shutdown

Startup connection or subscription failures reject application initialization and close the subscriber. Runtime fatal error events are logged through Nest's Logger by default. Applications can add an `events.on('error', handler)` listener to update health status or trigger their own shutdown policy. The module does not terminate the process automatically.

The subscriber closes when the Nest module is destroyed. Enable signal-driven cleanup during application bootstrap with `app.enableShutdownHooks()`; tests and application contexts should call `app.close()`.

PostgreSQL notifications are transient, not a durable job queue. Use the upstream SDK's typed `notify()` and notification handlers for payloads; application code remains responsible for validating received data and handling asynchronous listener failures.

[Contributing](https://github.com/thilllon/nestjs-kit/blob/main/CONTRIBUTING.md) · [Release setup](https://github.com/thilllon/nestjs-kit/blob/main/docs/releases.md)
