import { S3Client } from "@aws-sdk/client-s3";
import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";

import { MODULE_OPTIONS_TOKEN } from "./s3.constants";
import type { ModuleOptions } from "./s3.interface";

@Injectable()
export class S3Service extends S3Client implements OnModuleDestroy {
  constructor(@Inject(MODULE_OPTIONS_TOKEN) options: ModuleOptions) {
    super(options);
  }

  onModuleDestroy(): void {
    this.destroy();
  }
}
