# @nestjs-kit/redis

**Redis and Valkey clients for NestJS, with any client library.** Register how a client connects and disconnects; inject the native client by alias.

[![npm version](https://img.shields.io/npm/v/%40nestjs-kit%2Fredis)](https://www.npmjs.com/package/@nestjs-kit/redis)
[![npm monthly downloads](https://img.shields.io/npm/dm/%40nestjs-kit%2Fredis)](https://www.npmjs.com/package/@nestjs-kit/redis)
[![CI](https://img.shields.io/github/actions/workflow/status/thilllon/nestjs-kit/ci.yml?branch=main)](https://github.com/thilllon/nestjs-kit/actions/workflows/ci.yml)

## Install

Install the module with one of the client libraries below. Requires **Node.js 24+** and **NestJS 12** (`@nestjs/common` and `@nestjs/core`). Ships ESM, CommonJS, and TypeScript declarations. No client library is bundled or selected by default.

`connect` creates the client; bootstrap waits for it. `disconnect` closes it during application shutdown, after every `onModuleDestroy` and `beforeApplicationShutdown` hook. Call `app.enableShutdownHooks()` to also shut down on `SIGTERM` and other termination signals.

## [ioredis](https://www.npmjs.com/package/ioredis)

```sh
pnpm add @nestjs-kit/redis ioredis
```

```ts
import { RedisModule } from "@nestjs-kit/redis";
import { Redis } from "ioredis";

RedisModule.register({
  connect: () => new Redis(process.env.REDIS_URL ?? "redis://localhost:6379"),
  disconnect: (client) => client.quit(),
});
```

ioredis connects in the background, so an unreachable server does not fail bootstrap. To fail it, connect explicitly:

```ts
connect: async () => {
  const client = new Redis(url, { lazyConnect: true });
  await client.connect().catch((error: unknown) => {
    client.disconnect();
    throw error;
  });
  return client;
},
```

## [iovalkey](https://www.npmjs.com/package/iovalkey)

```sh
pnpm add @nestjs-kit/redis iovalkey
```

```ts
import { RedisModule } from "@nestjs-kit/redis";
import { Valkey } from "iovalkey";

RedisModule.register({
  connect: () => new Valkey(process.env.VALKEY_URL ?? "redis://localhost:6379"),
  disconnect: (client) => client.quit(),
});
```

iovalkey also connects in the background. To fail bootstrap on an unreachable server, use the ioredis `lazyConnect` snippet with `new Valkey(url, { lazyConnect: true })`.

## [redis](https://www.npmjs.com/package/redis) (node-redis)

```sh
pnpm add @nestjs-kit/redis redis
```

```ts
import { RedisModule } from "@nestjs-kit/redis";
import { createClient } from "redis";

RedisModule.register({
  connect: () =>
    createClient({ url: process.env.REDIS_URL })
      .on("error", (error: Error) => console.error(error))
      .connect(),
  disconnect: (client) => client.close(),
});
```

node-redis emits socket errors as `error` events, which end the process without a listener. With a listener, `connect()` retries an unreachable server, and bootstrap waits until `socket.reconnectStrategy` returns an `Error`.

## [@valkey/valkey-glide](https://www.npmjs.com/package/@valkey/valkey-glide)

```sh
pnpm add @nestjs-kit/redis @valkey/valkey-glide
```

```ts
import { RedisModule } from "@nestjs-kit/redis";
import { GlideClient } from "@valkey/valkey-glide";

RedisModule.register({
  connect: () =>
    GlideClient.createClient({
      addresses: [{ host: "localhost", port: 6379 }],
    }),
  disconnect: (client) => client.close(),
});
```

`createClient` resolves once connected. An unreachable server fails bootstrap after `advancedConfiguration.connectionTimeout`, 2000 ms by default.

## Named and async registrations

`alias` and `global` are module extras. Each alias gets its own client and shutdown; clients injected together need distinct aliases. `global: true` makes the client injectable in modules that do not import the registration.

```ts
RedisModule.registerAsync<Redis>({
  alias: "cache",
  global: true,
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    connect: () => new Redis(config.getOrThrow("CACHE_REDIS_URL")),
    disconnect: (client) => client.quit(),
  }),
});

constructor(@Inject(getRedisToken("cache")) private readonly cache: Redis) {}
```

An alias belongs to one registration. To share a client without `global`, create the registration once and import that `DynamicModule` object in every module that injects it.

## Tokens

`getRedisToken()` is `REDIS_CLIENT`; `getRedisToken("cache")` is `REDIS_CLIENT_cache`.

`getRedisOptionsToken()` returns the module-local configuration token for custom providers inside a registration. The options provider is not exported to parent or importing modules; use this helper only for providers added inside that registration or for registration-local tests. The generated builder token is private and is not exported from the package entry point.

## Errors

- A rejected `connect` fails bootstrap with its error. A `connect` that returns no client object fails with a `TypeError` naming the alias.
- Two modules that register one alias fail bootstrap before any client connects, with an `Error` naming the alias.
- When a registration fails, the clients that other registrations connected in the same bootstrap or lazy load are disconnected, best effort, before its error propagates; shutdown does not disconnect them again. A registration still connecting disconnects its client once `connect` resolves.
- Nest logs a rejected `disconnect` and continues shutting down other registrations; `app.close()` resolves, and the next `close()` calls `disconnect` again.
- A client that replaces the registration's provider, such as a test double from `overrideProvider(getRedisToken())`, is not passed to `disconnect`.
