import { MODULE_CLIENT_TOKEN, MODULE_OPTIONS_TOKEN } from "./s3.constants";

export const getClientToken = (alias = "") =>
  alias ? `${MODULE_CLIENT_TOKEN}_${alias}` : MODULE_CLIENT_TOKEN;

export const getOptionsToken = (alias = "") =>
  alias ? `${MODULE_OPTIONS_TOKEN}_${alias}` : MODULE_OPTIONS_TOKEN;
