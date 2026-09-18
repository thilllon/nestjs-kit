import { ConfigurableModuleBuilder } from "@nestjs/common";
import type { ModuleOptions } from "./cloudinary.interface";

export const {
  ConfigurableModuleClass,
  MODULE_OPTIONS_TOKEN,
  OPTIONS_TYPE,
  ASYNC_OPTIONS_TYPE,
} = new ConfigurableModuleBuilder<ModuleOptions>()
  .setExtras({ global: true }, (definition, extras) => ({
    ...definition,
    global: extras.global,
  }))
  .build();
