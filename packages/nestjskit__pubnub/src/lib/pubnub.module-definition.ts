import { ConfigurableModuleBuilder } from "@nestjs/common";
import type PubNub from "pubnub";

type PubnubConfig = ConstructorParameters<typeof PubNub>[0];

export const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } =
  new ConfigurableModuleBuilder<PubnubConfig>().build();

export const getOptionsToken = (alias = "") => {
  return MODULE_OPTIONS_TOKEN.toString() + alias;
};
