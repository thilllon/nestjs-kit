import { ConfigurableModuleBuilder, type DynamicModule } from "@nestjs/common";
import type { SendGridModuleOptions } from "./sendgrid.interface";
import { SendGridService } from "./sendgrid.service";
import { getSendGridToken } from "./sendgrid.tokens";

const {
  ConfigurableModuleClass,
  MODULE_OPTIONS_TOKEN,
  OPTIONS_TYPE,
  ASYNC_OPTIONS_TYPE,
} = new ConfigurableModuleBuilder<SendGridModuleOptions>()
  .setExtras(
    { alias: "default", global: false },
    (definition, extras): DynamicModule => {
      const token = getSendGridToken(extras.alias);
      return {
        ...definition,
        global: extras.global,
        providers: [
          ...(definition.providers ?? []),
          {
            provide: token,
            inject: [getSendGridOptionsToken()],
            useFactory: (options: SendGridModuleOptions) =>
              new SendGridService(options),
          },
        ],
        exports: [...(definition.exports ?? []), token],
      };
    },
  )
  .build();

export { ConfigurableModuleClass, OPTIONS_TYPE, ASYNC_OPTIONS_TYPE };

export function getSendGridOptionsToken(): string | symbol {
  return MODULE_OPTIONS_TOKEN;
}
