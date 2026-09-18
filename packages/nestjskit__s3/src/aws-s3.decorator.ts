import { Inject } from "@nestjs/common";

import { getClientToken, getOptionsToken } from "./aws-s3.utils";

export function InjectAwsS3Options(alias = "") {
  return Inject(getOptionsToken(alias));
}

export function InjectAwsS3Client(alias = "") {
  return Inject(getClientToken(alias));
}
