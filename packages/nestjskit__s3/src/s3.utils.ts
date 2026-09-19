import { MODULE_CLIENT_TOKEN } from "./s3.constants";

const OPTIONS_TOKEN = "S3_MODULE_OPTIONS_TOKEN";

export const getClientToken = (alias = "") =>
  alias ? `${MODULE_CLIENT_TOKEN}_${alias}` : MODULE_CLIENT_TOKEN;

export const getS3OptionsToken = (alias = "") =>
  alias ? `${OPTIONS_TOKEN}_${alias}` : OPTIONS_TOKEN;
