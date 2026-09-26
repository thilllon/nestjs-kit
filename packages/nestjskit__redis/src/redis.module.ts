import {
  type ConfigurableModuleAsyncOptions,
  type DynamicModule,
  Module,
} from "@nestjs/common";
import type { RedisModuleExtras, RedisModuleOptions } from "./redis.interface";
import { ConfigurableModuleClass } from "./redis.module-definition";

@Module({})
export class RedisModule extends ConfigurableModuleClass {
  static override register<TClient>(
    options: RedisModuleOptions<TClient> & Partial<RedisModuleExtras>,
  ): DynamicModule {
    return super.register(options);
  }

  static override registerAsync<TClient>(
    options: ConfigurableModuleAsyncOptions<RedisModuleOptions<TClient>> &
      Partial<RedisModuleExtras>,
  ): DynamicModule {
    return super.registerAsync(options);
  }
}
