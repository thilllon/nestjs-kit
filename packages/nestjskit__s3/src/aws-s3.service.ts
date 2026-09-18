import { S3Client } from "@aws-sdk/client-s3";
import { Injectable, type OnModuleDestroy } from "@nestjs/common";

import { InjectAwsS3Options } from "./aws-s3.decorator";
import type { ModuleOptions } from "./aws-s3.interface";

@Injectable()
export class AwsS3Service extends S3Client implements OnModuleDestroy {
  constructor(@InjectAwsS3Options() options: ModuleOptions) {
    super(options);
  }
  onModuleDestroy(): void {
    this.destroy();
  }
}
