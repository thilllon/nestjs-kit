import { ConfigurableModuleBuilder } from "@nestjs/common";
import type { ClientConfig } from "pg";
import type { Options } from "pg-listen";

export interface PgListenModuleOptions {
  connection?: ClientConfig;
  options?: Options;
  channels?: string[];
}

export const {
  ConfigurableModuleClass,
  MODULE_OPTIONS_TOKEN,
  OPTIONS_TYPE,
  ASYNC_OPTIONS_TYPE,
} = new ConfigurableModuleBuilder<PgListenModuleOptions>()
  .setExtras({ isGlobal: false }, (definition, extras) => ({
    ...definition,
    global: extras.isGlobal,
  }))
  .build();
