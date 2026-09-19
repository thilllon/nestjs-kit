import {
  ConfigurableModuleBuilder,
  type LoggerService,
  type DynamicModule,
} from "@nestjs/common";
import type { ClientConfig } from "pg";
import type { Options } from "pg-listen";
import { PgListenService } from "./pg-listen.service";
import {
  getPgListenServiceToken,
  getPgListenSubscriberToken,
} from "./pg-listen.tokens";

export interface PgListenModuleOptions {
  connection?: ClientConfig;
  options?: Options;
  channels?: string[];
  /** Per-registration logger; otherwise Nest global logger configuration applies. */
  logger?: LoggerService;
}

export interface PgListenModuleExtras {
  alias?: string;
  isGlobal?: boolean;
}

export const {
  ConfigurableModuleClass,
  MODULE_OPTIONS_TOKEN,
  OPTIONS_TYPE,
  ASYNC_OPTIONS_TYPE,
} = new ConfigurableModuleBuilder<PgListenModuleOptions>()
  .setExtras<PgListenModuleExtras>(
    { alias: "default", isGlobal: false },
    (definition, extras): DynamicModule => {
      const serviceToken = getPgListenServiceToken(extras.alias);
      const subscriberToken = getPgListenSubscriberToken(extras.alias);
      return {
        ...definition,
        global: extras.isGlobal,
        providers: [
          ...(definition.providers ?? []),
          {
            provide: serviceToken,
            inject: [MODULE_OPTIONS_TOKEN],
            useFactory: (options: PgListenModuleOptions) =>
              new PgListenService(options),
          },
          {
            provide: subscriberToken,
            inject: [serviceToken],
            useFactory: (service: PgListenService) => service.subscriber,
          },
        ],
        exports: [...(definition.exports ?? []), serviceToken, subscriberToken],
      };
    },
  )
  .build();
