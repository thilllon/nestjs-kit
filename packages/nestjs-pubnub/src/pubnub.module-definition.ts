import { ConfigurableModuleBuilder, type DynamicModule } from "@nestjs/common";
import type PubNub from "pubnub";
import { PubNubService } from "./pubnub.service";
import { getPubNubClientToken } from "./pubnub.tokens";

export type PubNubModuleOptions = ConstructorParameters<typeof PubNub>[0];

export const {
  ConfigurableModuleClass,
  MODULE_OPTIONS_TOKEN,
  OPTIONS_TYPE,
  ASYNC_OPTIONS_TYPE,
} = new ConfigurableModuleBuilder<PubNubModuleOptions>()
  .setExtras(
    { alias: "default", isGlobal: false },
    (definition, extras): DynamicModule => {
      const token = getPubNubClientToken(extras.alias);
      return {
        ...definition,
        global: extras.isGlobal,
        providers: [
          ...(definition.providers ?? []),
          {
            provide: token,
            inject: [MODULE_OPTIONS_TOKEN],
            useFactory: (options: PubNubModuleOptions) =>
              new PubNubService(options),
          },
        ],
        exports: [...(definition.exports ?? []), token],
      };
    },
  )
  .build();
