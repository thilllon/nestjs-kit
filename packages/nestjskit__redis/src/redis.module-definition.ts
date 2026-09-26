import { ConfigurableModuleBuilder, type DynamicModule } from "@nestjs/common";
import { connectRedisClient, RedisConnection } from "./redis.connection";
import type { RedisModuleExtras, RedisModuleOptions } from "./redis.interface";
import { getRedisToken } from "./redis.tokens";

const {
  ConfigurableModuleClass,
  MODULE_OPTIONS_TOKEN,
  OPTIONS_TYPE,
  ASYNC_OPTIONS_TYPE,
} = new ConfigurableModuleBuilder<RedisModuleOptions>()
  .setExtras<RedisModuleExtras>(
    { alias: "default", isGlobal: false },
    (definition, extras): DynamicModule => {
      const token = getRedisToken(extras.alias);
      const connection = Symbol(`REDIS_CONNECTION_${extras.alias}`);
      return {
        ...definition,
        global: extras.isGlobal,
        providers: [
          ...(definition.providers ?? []),
          {
            provide: token,
            inject: [getRedisOptionsToken()],
            useFactory: (options: RedisModuleOptions) =>
              connectRedisClient(options, extras.alias),
          },
          {
            provide: connection,
            inject: [getRedisOptionsToken(), token],
            useFactory: (options: RedisModuleOptions, client: unknown) =>
              new RedisConnection(client, options),
          },
        ],
        exports: [...(definition.exports ?? []), token],
      };
    },
  )
  .build();

export { ConfigurableModuleClass, OPTIONS_TYPE, ASYNC_OPTIONS_TYPE };

export function getRedisOptionsToken(): string | symbol {
  return MODULE_OPTIONS_TOKEN;
}
