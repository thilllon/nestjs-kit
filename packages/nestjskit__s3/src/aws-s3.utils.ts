import { MODULE_CLIENT_TOKEN, MODULE_OPTIONS_TOKEN } from "./aws-s3.constants";

export const getClientToken = (alias = "") => MODULE_CLIENT_TOKEN + alias;
export const getOptionsToken = (alias = "") => MODULE_OPTIONS_TOKEN + alias;
