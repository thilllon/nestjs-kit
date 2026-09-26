import { ConfigurableModuleBuilder, type DynamicModule } from "@nestjs/common";
import { ModulesContainer } from "@nestjs/core";
import {
  connectRedisClient,
  REDIS_REGISTRATION,
  RedisConnection,
} from "./redis.connection";
import type { RedisModuleExtras, RedisModuleOptions } from "./redis.interface";
import { getRedisToken } from "./redis.tokens";

// alwaysTransient keeps separate register() calls from merging into one
// module when their metadata serializes identically.
const {
  ConfigurableModuleClass,
  MODULE_OPTIONS_TOKEN,
  OPTIONS_TYPE,
  ASYNC_OPTIONS_TYPE,
} = new ConfigurableModuleBuilder<RedisModuleOptions>({ alwaysTransient: true })
  .setExtras<RedisModuleExtras>(
    { alias: "default", global: false },
    (definition, extras): DynamicModule => {
      const alias = extras.alias || "default";
      const token = getRedisToken(alias);
      const connection = Symbol(`REDIS_CONNECTION_${alias}`);
      return {
        ...definition,
        global: extras.global,
        providers: [
          ...(definition.providers ?? []),
          { provide: REDIS_REGISTRATION, useValue: alias },
          {
            provide: token,
            inject: [getRedisOptionsToken(), ModulesContainer],
            useFactory: (
              options: RedisModuleOptions,
              modules: ModulesContainer,
            ) => connectRedisClient(options, alias, modules),
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
