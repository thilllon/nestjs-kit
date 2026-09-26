import { ConfigurableModuleBuilder, type DynamicModule } from "@nestjs/common";
import type { SendbirdModuleOptions } from "./sendbird.interface";
import { SendbirdService } from "./sendbird.service";
import { getSendbirdToken } from "./sendbird.tokens";

const {
  ConfigurableModuleClass,
  MODULE_OPTIONS_TOKEN,
  OPTIONS_TYPE,
  ASYNC_OPTIONS_TYPE,
} = new ConfigurableModuleBuilder<SendbirdModuleOptions>()
  .setExtras(
    { alias: "default", global: false },
    (definition, extras): DynamicModule => {
      const token = getSendbirdToken(extras.alias);
      return {
        ...definition,
        global: extras.global,
        providers: [
          ...(definition.providers ?? []),
          {
            provide: token,
            inject: [getSendbirdOptionsToken()],
            useFactory: (options: SendbirdModuleOptions) =>
              new SendbirdService(options),
          },
        ],
        exports: [...(definition.exports ?? []), token],
      };
    },
  )
  .build();

export { ConfigurableModuleClass, OPTIONS_TYPE, ASYNC_OPTIONS_TYPE };

export function getSendbirdOptionsToken(): string | symbol {
  return MODULE_OPTIONS_TOKEN;
}
