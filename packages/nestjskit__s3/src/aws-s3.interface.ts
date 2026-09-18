/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ModuleMetadata, Type } from "@nestjs/common";

import type { S3ClientConfig } from "@aws-sdk/client-s3";

export type ModuleOptions = S3ClientConfig;

export interface ExtraModuleOptions {
  /**
   * alias for module
   * @default ''
   */
  alias?: string;

  /**
   * global module
   * @default false
   */
  global?: boolean;
}

export interface ModuleOptionsFactory {
  create(): Promise<ModuleOptions> | ModuleOptions;
}

export interface AsyncModuleOptions extends Pick<ModuleMetadata, "imports"> {
  inject?: any[];
  useClass?: Type<ModuleOptionsFactory>;
  useExisting?: Type<ModuleOptionsFactory>;
  useFactory?: (...args: any[]) => Promise<ModuleOptions> | ModuleOptions;
}
