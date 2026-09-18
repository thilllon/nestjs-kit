/* eslint-disable @typescript-eslint/no-explicit-any */
import { StoragePipelineOptions } from "@azure/storage-blob";
import { ModuleMetadata, Scope, Type } from "@nestjs/common";

export type ModuleOptions = {
  connection: string;
  storageOptions?: StoragePipelineOptions;
};

export interface ExtraModuleOptions {
  global?: boolean;
  scope?: Scope;
}

export type ModuleOptionsFactory = {
  createModuleOptions(): Promise<ModuleOptions> | ModuleOptions;
};

export interface AsyncModuleOptions extends Pick<ModuleMetadata, "imports"> {
  inject?: any[];
  useExisting?: Type<ModuleOptionsFactory>;
  useClass?: Type<ModuleOptionsFactory>;
  useFactory?: (...args: any[]) => Promise<ModuleOptions> | ModuleOptions;
}

export type GetAccountSasUrlResponse = {
  sasUrl: string;
  headers: Record<string, string | number>;
};

export type GetContainerSasUrlResponse = {
  sasUrl: string;
  headers: Record<string, string | number>;
};

export type GetBlockBlobSasUrlResponse = {
  sasUrl: string;
  headers: Record<string, string | number>;
};
