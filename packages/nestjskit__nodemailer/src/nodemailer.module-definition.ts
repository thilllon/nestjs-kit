import { ConfigurableModuleBuilder } from "@nestjs/common";
import type { NodemailerModuleOptions } from "./nodemailer.interface";

const {
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

export { ConfigurableModuleClass, OPTIONS_TYPE, ASYNC_OPTIONS_TYPE };

export function getNodemailerOptionsToken(): string | symbol {
  return MODULE_OPTIONS_TOKEN;
}
