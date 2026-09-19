import { getAzureStorageBlobOptionsToken } from "./azure-storage-blob.constants";
import { BlobServiceClient } from "@azure/storage-blob";
import {
  type DynamicModule,
  Module,
  type Provider,
  type Type,
} from "@nestjs/common";
import { MODULE_CONNECTION_VARIABLE_TOKEN } from "./azure-storage-blob.constants";
import type {
  AsyncModuleOptions,
  ExtraModuleOptions,
  ModuleOptions,
  ModuleOptionsFactory,
} from "./azure-storage-blob.interface";
import { AzureStorageBlobService } from "./azure-storage-blob.service";
import {
  getAzureStorageBlobServiceToken,
  getStorageBlobClientToken,
} from "./azure-storage-blob.tokens";

@Module({})
export class AzureStorageBlobModule {
  static register(
    options: ModuleOptions,
    extras?: ExtraModuleOptions,
  ): DynamicModule {
    return this.createModule(
      [
        {
          provide: getAzureStorageBlobOptionsToken(extras?.alias),
          useValue: options,
        },
      ],
      extras,
    );
  }

  static registerAsync(
    options: AsyncModuleOptions,
    extras?: ExtraModuleOptions,
  ): DynamicModule {
    return {
      ...this.createModule(this.createAsyncProviders(options, extras), extras),
      imports: options.imports,
    };
  }

  private static createModule(
    optionsProviders: Provider[],
    extras?: ExtraModuleOptions,
  ): DynamicModule {
    const optionsToken = getAzureStorageBlobOptionsToken(extras?.alias);
    const clientToken = getStorageBlobClientToken(extras?.alias);
    const serviceToken = getAzureStorageBlobServiceToken(extras?.alias);
    return {
      module: AzureStorageBlobModule,
      global: extras?.global,
      providers: [
        ...optionsProviders,
        {
          provide: clientToken,
          useFactory: (options: ModuleOptions) => this.createClient(options),
          inject: [optionsToken],
          scope: extras?.scope,
        },
        {
          provide: serviceToken,
          useFactory: (client: BlobServiceClient, options: ModuleOptions) =>
            new AzureStorageBlobService(client, options),
          inject: [clientToken, optionsToken],
          scope: extras?.scope,
        },
      ],
      exports: [clientToken, optionsToken, serviceToken],
    };
  }

  private static createAsyncProviders(
    options: AsyncModuleOptions,
    extras?: ExtraModuleOptions,
  ): Provider[] {
    const token = getAzureStorageBlobOptionsToken(extras?.alias);
    if (options.useFactory) {
      return [
        {
          provide: token,
          useFactory: options.useFactory,
          inject: options.inject,
          scope: extras?.scope,
        },
      ];
    }
    const factory = options.useClass ?? options.useExisting;
    if (!factory) {
      throw new Error(
        "One of useClass, useFactory or useExisting should be provided",
      );
    }
    return [
      ...(options.useClass
        ? [
            {
              provide: options.useClass,
              useClass: options.useClass,
              scope: extras?.scope,
            },
          ]
        : []),
      {
        provide: token,
        useFactory: (optionsFactory: ModuleOptionsFactory) =>
          optionsFactory.createModuleOptions(),
        inject: [factory as Type<ModuleOptionsFactory>],
        scope: extras?.scope,
      },
    ];
  }

  private static createClient(options: ModuleOptions): BlobServiceClient {
    if (!options.connection) {
      throw new Error(
        `Environment variable is required: "${MODULE_CONNECTION_VARIABLE_TOKEN}"`,
      );
    }
    return BlobServiceClient.fromConnectionString(
      options.connection,
      options.storageOptions,
    );
  }
}
