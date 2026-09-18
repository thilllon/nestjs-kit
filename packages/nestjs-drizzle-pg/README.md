# nestjs-drizzle-pg

[![npm version](https://img.shields.io/npm/v/nestjs-drizzle-pg)](https://www.npmjs.com/package/nestjs-drizzle-pg)
[![npm monthly downloads](https://img.shields.io/npm/dm/nestjs-drizzle-pg)](https://www.npmjs.com/package/nestjs-drizzle-pg)
[![CI](https://img.shields.io/github/actions/workflow/status/thilllon/nestjs-kit/ci.yml?branch=main)](https://github.com/thilllon/nestjs-kit/actions/workflows/ci.yml)

**Drizzle ORM and PostgreSQL for NestJS.** Register a connection, inject a typed database, and query with Drizzle. The module manages connection creation and shutdown, including independent named databases.

[Quick start](#quick-start) · [Async configuration](#asynchronous-configuration) · [Multiple databases](#multiple-databases) · [Connection lifecycle](#connection-lifecycle) · [API reference](#api-reference)

## Install

```sh
pnpm add nestjs-drizzle-pg drizzle-orm pg
```

Requires **Node.js 24+** and **NestJS 12**. Ships ESM, CommonJS, and TypeScript declarations. The package name stays `nestjs-drizzle-pg`.

## Quick start

Set `DATABASE_URL` in your application environment, then define a schema:

```ts
// schema.ts
import { integer, pgTable, text } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  name: text("name").notNull(),
});
```

Register the schema and a PostgreSQL pool in the same module as your service:

```ts
// users.module.ts
import { Injectable, Module } from "@nestjs/common";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { DrizzlePgModule, InjectDrizzlePg } from "nestjs-drizzle-pg";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required");
}

@Injectable()
export class UsersService {
  constructor(
    @InjectDrizzlePg()
    private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  list() {
    return this.db.query.users.findMany({ limit: 25 });
  }

  create(name: string) {
    return this.db.insert(schema.users).values({ name }).returning();
  }
}

@Module({
  imports: [
    DrizzlePgModule.register({
      pgConfig: { type: "pool", config: { connectionString, max: 10 } },
      drizzleConfig: { schema },
    }),
  ],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
```

Import `UsersModule` into your application and inject `UsersService` where needed. `list()` returns typed user rows; `create()` inserts a row and returns the inserted values.

**Create the database tables before querying.** The module does not run migrations or synchronize the schema. Use your project's Drizzle migration workflow; for this small example, the equivalent SQL is:

```sql
CREATE TABLE users (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL
);
```

Pass the same schema to `drizzleConfig.schema` and `NodePgDatabase<typeof schema>`: the first configures Drizzle at runtime, while the second gives your injected database its query types. Table imports also work with Drizzle's `select`, `insert`, `update`, and `delete` builders.

## Asynchronous configuration

Use `registerAsync()` when options depend on another Nest provider. Install `@nestjs/config` for this example, and place the registration in your module's `imports`:

```ts
import { ConfigModule, ConfigService } from "@nestjs/config";
import { DrizzlePgModule } from "nestjs-drizzle-pg";
import * as schema from "./schema";

DrizzlePgModule.registerAsync({
  imports: [ConfigModule.forRoot()],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    pgConfig: {
      type: "pool" as const,
      config: {
        connectionString: config.getOrThrow<string>("DATABASE_URL"),
        max: 10,
        connectionTimeoutMillis: 5_000,
      },
    },
    drizzleConfig: { schema },
  }),
});
```

The factory may also return a promise. `registerAsync()` supports `useClass` and `useExisting` factories with a `create()` method returning `DrizzlePgModuleOptions` or a promise of those options.

## Multiple databases

Give each additional registration a distinct alias. Both `alias` and `isGlobal` belong at the top level of the registration, including for `registerAsync()`; they do not belong inside its `useFactory` result.

```ts
import { Inject, Injectable, Module } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  DrizzlePgModule,
  DrizzlePgService,
  getDrizzlePgServiceToken,
  InjectDrizzlePg,
} from "nestjs-drizzle-pg";

const connectionString = process.env.ANALYTICS_DATABASE_URL;
if (!connectionString) {
  throw new Error("ANALYTICS_DATABASE_URL is required");
}

@Injectable()
export class AnalyticsService {
  constructor(
    @InjectDrizzlePg("analytics") private readonly db: NodePgDatabase,
    @Inject(getDrizzlePgServiceToken("analytics"))
    private readonly connection: DrizzlePgService,
  ) {}

  databaseTime() {
    return this.db.execute(sql`select current_timestamp as time`);
  }

  isReachable() {
    return this.connection.ping();
  }
}

@Module({
  imports: [
    DrizzlePgModule.register({
      alias: "analytics",
      pgConfig: { type: "pool", config: { connectionString } },
    }),
  ],
  providers: [AnalyticsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
```

The unnamed registration uses the `default` alias. Inject its database with `@InjectDrizzlePg()` and its health service directly as `DrizzlePgService`. Register the module once per alias; use another alias for a different database or connection configuration.

Modules are local by default. Set `isGlobal: true` only when the registered providers should be available throughout the application; otherwise import the registration into the module containing its consumers, or re-export it through a shared module.

## Connection lifecycle

| Configuration                          | Startup behavior                                                                | When to use it                                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `pgConfig: { type: "pool", config }`   | Creates a pool; database connections are acquired as queries run.               | Application services serving concurrent requests.                                                     |
| `pgConfig: { type: "client", config }` | Connects one client during Nest initialization; connection errors fail startup. | A module that deliberately uses a single PostgreSQL session.                                          |
| Omit `pgConfig`                        | Creates and connects a client using node-postgres environment defaults.         | Applications already configured through `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, and `PGDATABASE`. |

`config` is passed to node-postgres as `PoolConfig` or `ClientConfig`, including connection strings, TLS and timeout options. A lazy pool does not prove database availability at startup: execute a query or call the registered `DrizzlePgService.ping()` when your readiness policy requires a check. `ping()` returns `false` if its query fails.

The module creates and owns its connections; registering an existing external pool/client is not supported. Each registered connection is ended by the module's shutdown hook. Do not manually call `end()` on a module-owned connection during normal operation.

Enable Nest shutdown hooks in your application's existing bootstrap so process signals trigger cleanup:

```ts
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  await app.listen(3000);
}

void bootstrap();
```

For tests or standalone application contexts, call `app.close()` / `module.close()` when finished. If a client fails to connect during initialization, the module attempts to close it before propagating the startup error.

## API reference

| API                                      | Purpose                                                          |
| ---------------------------------------- | ---------------------------------------------------------------- |
| `DrizzlePgModule.register(options)`      | Register connection and Drizzle options synchronously.           |
| `DrizzlePgModule.registerAsync(options)` | Build options through Nest dependency injection.                 |
| `@InjectDrizzlePg(alias?)`               | Inject a Drizzle database; defaults to the unnamed registration. |
| `getDrizzlePgToken(alias?)`              | Get the database token for `@Inject()` or module lookups.        |
| `DrizzlePgService.ping()`                | Execute `SELECT 1` and return a `Promise<boolean>`.              |
| `getDrizzlePgServiceToken(alias)`        | Get the health-service token for a named registration.           |
| `drizzleConfig`                          | Forward Drizzle configuration, such as `schema` and `logger`.    |
| `alias` / `isGlobal`                     | Choose a registration name and whether its providers are global. |

Use Drizzle itself for queries, transactions and migrations. This package supplies Nest registration, injection and connection lifecycle management.

## Project

[Report an issue](https://github.com/thilllon/nestjs-kit/issues/new/choose) · [Contributing](https://github.com/thilllon/nestjs-kit/blob/main/CONTRIBUTING.md) · [License](https://github.com/thilllon/nestjs-kit/blob/main/LICENSE)
