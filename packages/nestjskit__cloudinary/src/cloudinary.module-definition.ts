import { ConfigurableModuleBuilder, type DynamicModule } from "@nestjs/common";
import type { ModuleOptions } from "./cloudinary.interface";
import { CloudinaryService } from "./cloudinary.service";
import { getCloudinaryToken } from "./cloudinary.tokens";

const {
  ConfigurableModuleClass,
  MODULE_OPTIONS_TOKEN,
  OPTIONS_TYPE,
  ASYNC_OPTIONS_TYPE,
} = new ConfigurableModuleBuilder<ModuleOptions>()
  .setExtras(
    { alias: "default", global: true },
    (definition, extras): DynamicModule => {
      const token = getCloudinaryToken(extras.alias);
      return {
        ...definition,
        global: extras.global,
        providers: [
          ...(definition.providers ?? []),
          {
            provide: token,
            inject: [getCloudinaryOptionsToken()],
            useFactory: (options: ModuleOptions) =>
              new CloudinaryService(options),
          },
        ],
        exports: [...(definition.exports ?? []), token],
      };
    },
  )
  .build();

export { ConfigurableModuleClass, OPTIONS_TYPE, ASYNC_OPTIONS_TYPE };

export function getCloudinaryOptionsToken(): string | symbol {
  return MODULE_OPTIONS_TOKEN;
}
