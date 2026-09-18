import { Inject } from "@nestjs/common";

import { getClientToken, getOptionsToken } from "./s3.utils";

export function InjectS3Options(alias = "") {
  return Inject(getOptionsToken(alias));
}

export function InjectS3Client(alias = "") {
  return Inject(getClientToken(alias));
}
