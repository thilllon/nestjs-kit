import { ConfigurableModuleBuilder } from "@nestjs/common";
import type { NodemailerModuleOptions } from "./nodemailer.interface";

export const {
  ConfigurableModuleClass,
  MODULE_OPTIONS_TOKEN,
  OPTIONS_TYPE,
  ASYNC_OPTIONS_TYPE,
} = new ConfigurableModuleBuilder<NodemailerModuleOptions>()
  .setExtras({ global: false }, (definition, extras) => ({
    ...definition,
    global: extras.global,
  }))
  .build();
