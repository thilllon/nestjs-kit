# @nestjs-kit/redis

**Redis and Valkey clients for NestJS, with any client library.** Register how a client connects and disconnects; inject the native client by alias.

[![npm version](https://img.shields.io/npm/v/%40nestjs-kit%2Fredis)](https://www.npmjs.com/package/@nestjs-kit/redis)
[![npm monthly downloads](https://img.shields.io/npm/dm/%40nestjs-kit%2Fredis)](https://www.npmjs.com/package/@nestjs-kit/redis)
[![CI](https://img.shields.io/github/actions/workflow/status/thilllon/nestjs-kit/ci.yml?branch=main)](https://github.com/thilllon/nestjs-kit/actions/workflows/ci.yml)

## Install

Install the module and the client library you use:

```sh
pnpm add @nestjs-kit/redis ioredis
```

Requires **Node.js 24+** and **NestJS 12**. Ships ESM, CommonJS, and TypeScript declarations. No client library is bundled or selected by default.

## Register a client

`connect` creates the client; bootstrap waits for it. `disconnect` closes it during application shutdown, after every `onModuleDestroy` and `beforeApplicationShutdown` hook.

```ts
import { RedisModule } from "@nestjs-kit/redis";
import { Redis } from "ioredis";

RedisModule.register({
  connect: () => new Redis(process.env.REDIS_URL),
  disconnect: (client) => client.quit(),
});
```

```ts
import { getRedisToken } from "@nestjs-kit/redis";

constructor(@Inject(getRedisToken()) private readonly redis: Redis) {}
```

## Client libraries

| Client               | `connect`                                | `disconnect`                 |
| -------------------- | ---------------------------------------- | ---------------------------- |
| ioredis              | `() => new Redis(url)`                   | `(client) => client.quit()`  |
| iovalkey             | `() => new Valkey(url)`                  | `(client) => client.quit()`  |
| redis                | `() => createClient({ url }).connect()`  | `(client) => client.close()` |
| @valkey/valkey-glide | `() => GlideClient.createClient(config)` | `(client) => client.close()` |

ioredis and iovalkey connect in the background, so an unreachable server does not fail bootstrap. To fail it, connect explicitly:

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

## Named and async registrations

`alias` and `isGlobal` are module extras. Each alias gets its own client and shutdown; clients injected together need distinct aliases.

```ts
RedisModule.registerAsync<Redis>({
  alias: "cache",
  isGlobal: true,
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    connect: () => new Redis(config.getOrThrow("CACHE_REDIS_URL")),
    disconnect: (client) => client.quit(),
  }),
});

constructor(@Inject(getRedisToken("cache")) private readonly cache: Redis) {}
```

`getRedisToken()` is `REDIS_CLIENT`; `getRedisToken("cache")` is `REDIS_CLIENT_cache`. `getRedisOptionsToken()` injects the registration options.

## Errors

- A rejected `connect` fails bootstrap with its error. A `connect` that returns nothing fails with a `TypeError` naming the alias.
- A rejected `disconnect` rejects `app.close()`; the next shutdown calls it again.
