# nestjs-drizzle-pg

[![npm version](https://img.shields.io/npm/v/nestjs-drizzle-pg)](https://www.npmjs.com/package/nestjs-drizzle-pg)
[![npm monthly downloads](https://img.shields.io/npm/dm/nestjs-drizzle-pg)](https://www.npmjs.com/package/nestjs-drizzle-pg)
[![CI](https://img.shields.io/github/actions/workflow/status/thilllon/nestjs-kit/ci.yml?branch=main)](https://github.com/thilllon/nestjs-kit/actions/workflows/ci.yml)

Drizzle ORM with PostgreSQL in NestJS. Register a pool or a single client and inject a Drizzle database into application services.

```sh
pnpm add nestjs-drizzle-pg drizzle-orm pg
pnpm add -D @types/pg
```

The npm name remains `nestjs-drizzle-pg`; it does not move to the new scope.

Requires Node.js 24 or newer and NestJS 12. Both ESM and CommonJS are supported.

## Register and query

```ts
import { Injectable, Module } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { NodePgDatabase } from "drizzle-orm/node-postgres";
import { DrizzlePgModule, InjectDrizzlePg } from "nestjs-drizzle-pg";

@Injectable()
export class DatabaseService {
  constructor(@InjectDrizzlePg() private readonly db: NodePgDatabase) {}

  ping() {
    return this.db.execute(sql`select 1`);
  }
}

@Module({
  imports: [
    DrizzlePgModule.register({
      pgConfig: {
        type: "pool",
        config: { connectionString: process.env.DATABASE_URL },
      },
    }),
  ],
  providers: [DatabaseService],
  exports: [DatabaseService],
})
export class DatabaseModule {}
```

Set `DATABASE_URL` before startup, or use node-postgres's standard environment variables. Pass `{ schema }` through `drizzleConfig` to use your Drizzle schema. A pool acquires connections when needed; `type: 'client'` connects during module initialization.

## Configure asynchronously

With `@nestjs/config` installed, place this registration in `imports`:

```ts
import { ConfigModule, ConfigService } from "@nestjs/config";
import { DrizzlePgModule } from "nestjs-drizzle-pg";

DrizzlePgModule.registerAsync({
  imports: [ConfigModule.forRoot()],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    pgConfig: {
      type: "pool" as const,
      config: { connectionString: config.getOrThrow<string>("DATABASE_URL") },
    },
  }),
});
```

## Named databases and shutdown

Set `alias: 'analytics'` at the top level of `register` or `registerAsync`, and use `@InjectDrizzlePg('analytics')` to select that database. Set `isGlobal: true` at the same level for global registration.

`DrizzlePgService.ping()` checks the default connection. For a named service, inject `getDrizzlePgServiceToken('analytics')` through Nest's `@Inject()` decorator. Connections close when the module is destroyed; use `app.enableShutdownHooks()` to handle process shutdown signals.

[Contributing](https://github.com/thilllon/nestjs-kit/blob/main/CONTRIBUTING.md)
