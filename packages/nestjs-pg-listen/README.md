# nestjs-pg-listen

[![npm version](https://img.shields.io/npm/v/nestjs-pg-listen)](https://www.npmjs.com/package/nestjs-pg-listen)
[![npm monthly downloads](https://img.shields.io/npm/dm/nestjs-pg-listen)](https://www.npmjs.com/package/nestjs-pg-listen)
[![CI](https://img.shields.io/github/actions/workflow/status/thilllon/nestjs-kit/ci.yml?branch=main)](https://github.com/thilllon/nestjs-kit/actions/workflows/ci.yml)

PostgreSQL LISTEN / NOTIFY for NestJS, powered by [pg-listen](https://github.com/andywer/pg-listen). Inject its typed subscriber while Nest manages connection startup, channel subscriptions, and shutdown.

Install it in your NestJS application:

```sh
pnpm add nestjs-pg-listen pg-listen pg
```

Requires Node.js 24 or newer and NestJS 12. Both ESM and CommonJS are supported.

## Register and receive notifications

```ts
import { Inject, Injectable, Module, OnModuleInit } from "@nestjs/common";
import {
  getPgListenSubscriberToken,
  PgListenModule,
  Subscriber,
} from "nestjs-pg-listen";

type Events = { orders: { id: string } };

@Injectable()
export class OrdersListener implements OnModuleInit {
  constructor(
    @Inject(getPgListenSubscriberToken())
    private readonly subscriber: Subscriber<Events>,
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

Both registration methods accept `alias` and `isGlobal` at the top level. These are module registration settings, not values returned by `useFactory`.

## Multiple connections

Register once per alias to give each database its own subscriber, options, channels and lifecycle. A default connection can coexist with named connections:

```ts
import { Inject, Injectable, Module, OnModuleInit } from "@nestjs/common";
import {
  getPgListenSubscriberToken,
  getPgListenServiceToken,
  PgListenModule,
  PgListenService,
  Subscriber,
} from "nestjs-pg-listen";

@Injectable()
export class AuditListener implements OnModuleInit {
  constructor(
    @Inject(getPgListenSubscriberToken()) private readonly orders: Subscriber,
    @Inject(getPgListenSubscriberToken("audit"))
    private readonly audit: Subscriber,
    @Inject(getPgListenServiceToken("audit"))
    private readonly auditService: PgListenService,
  ) {}

  onModuleInit() {
    this.orders.notifications.on("orders", console.log);
    this.audit.notifications.on("audit_events", console.log);
  }

  record(event: unknown) {
    return this.auditService.subscriber.notify("audit_events", event);
  }
}

@Module({
  imports: [
    PgListenModule.register({
      connection: { connectionString: process.env.DATABASE_URL },
      channels: ["orders"],
    }),
    PgListenModule.registerAsync({
      alias: "audit",
      useFactory: async () => ({
        connection: { connectionString: process.env.AUDIT_DATABASE_URL },
        channels: ["audit_events"],
        options: { retryTimeout: 15_000 },
      }),
    }),
  ],
  providers: [AuditListener],
})
export class NotificationsModule {}
```

Set both database URLs for this example. Use unique aliases for additional connections. Omitted, empty (`""`) and `"default"` aliases all identify the default registration. Its `@Inject(getPgListenSubscriberToken())`, `PG_LISTEN_SUBSCRIBER` and direct `PgListenService` injection remain supported. Named registrations export only their named subscriber and service tokens.

| API                                  | Purpose                                                           |
| ------------------------------------ | ----------------------------------------------------------------- |
| `getPgListenSubscriberToken(alias?)` | Resolve the subscriber token for `@Inject()` or module lookups.   |
| `getPgListenServiceToken(alias?)`    | Resolve the service token; the default returns `PgListenService`. |

Registrations are local to their importing module. Re-export a shared registration module to make it available to consumers elsewhere, or set `isGlobal: true` for application-wide access. Each registration connects, subscribes and closes independently. Applications should let Nest own subscriber shutdown rather than calling the raw subscriber's `close()` themselves.

## Logging

The default `new Logger(PgListenService.name)` follows Nest's application-wide logger: both `app.useLogger(customLogger)` and `Logger.overrideLogger(customLogger)` receive subscriber errors and startup-cleanup errors. No package-specific logger setup is needed when the application already uses a custom Nest logger.

For a different logger per registration, set `logger` to any Nest `LoggerService`. Resolve an application-owned logger through async configuration, for example a logger that forwards records to Kafka:

```ts
import { Module, type LoggerService } from "@nestjs/common";
import { PgListenModule } from "nestjs-pg-listen";
import { ApplicationLoggingModule, KafkaLogger } from "./application-logging";

@Module({
  imports: [
    PgListenModule.registerAsync({
      alias: "audit",
      imports: [ApplicationLoggingModule],
      inject: [KafkaLogger],
      useFactory: (logger: LoggerService) => ({
        connection: { connectionString: process.env.AUDIT_DATABASE_URL },
        channels: ["audit_events"],
        logger,
      }),
    }),
  ],
})
export class AuditNotificationsModule {}
```

`ApplicationLoggingModule` and `KafkaLogger` are application providers, not dependencies of this package. Export the logger from that module and implement Nest's `LoggerService` contract. A registration-local logger takes precedence over the Nest global logger for that subscriber only. Logging does not replace propagation of the original startup error or lifecycle cleanup.

## Injection API changes

Package-specific injection decorators have been removed. Import `Inject` from `@nestjs/common` and pass the public token helpers, as shown above. The default `PG_LISTEN_SUBSCRIBER` token and `PgListenService` class remain available. Named tokens use `PG_LISTEN_SUBSCRIBER_<alias>` and `PG_LISTEN_SERVICE_<alias>`; prefer the helpers over hand-written strings.

## Errors and shutdown

Startup connection or subscription failures reject application initialization and close the subscriber. Runtime fatal error events are logged through Nest's Logger by default. Applications can add an `events.on('error', handler)` listener to update health status or trigger their own shutdown policy. The module does not terminate the process automatically.

The subscriber closes when the Nest module is destroyed. Enable signal-driven cleanup during application bootstrap with `app.enableShutdownHooks()`; tests and application contexts should call `app.close()`.

PostgreSQL notifications are transient, not a durable job queue. Use the upstream SDK's typed `notify()` and notification handlers for payloads; application code remains responsible for validating received data and handling asynchronous listener failures.

[Contributing](https://github.com/thilllon/nestjs-kit/blob/main/CONTRIBUTING.md) · [Release setup](https://github.com/thilllon/nestjs-kit/blob/main/docs/releases.md)

## Options token

Use `getPgListenOptionsToken()` when extending a registration with providers that need its options. Generic `MODULE_OPTIONS_TOKEN` is not part of the public API. The helper returns the existing Nest configurable-module token and deliberately accepts no alias: Nest keeps that provider local to each dynamic module registration. It does not export the options provider to importing modules or change registration visibility. Keep additional providers inside the registration that owns those options.
