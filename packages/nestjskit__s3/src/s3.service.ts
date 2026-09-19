import { S3Client } from "@aws-sdk/client-s3";
import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";

import { getS3OptionsToken } from "./s3.utils";
import type { ModuleOptions } from "./s3.interface";

@Injectable()
export class S3Service extends S3Client implements OnModuleDestroy {
  constructor(@Inject(getS3OptionsToken()) options: ModuleOptions) {
    super(options);
  }

  onModuleDestroy(): void {
    this.destroy();
  }
}
