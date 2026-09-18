import { S3Client } from "@aws-sdk/client-s3";
import { Injectable, type OnModuleDestroy } from "@nestjs/common";

import { InjectS3Options } from "./s3.decorator";
import type { ModuleOptions } from "./s3.interface";

@Injectable()
export class S3Service extends S3Client implements OnModuleDestroy {
  constructor(@InjectS3Options() options: ModuleOptions) {
    super(options);
  }
  onModuleDestroy(): void {
    this.destroy();
  }
}
