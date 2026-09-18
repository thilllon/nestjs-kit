import { BlobServiceClient } from "@azure/storage-blob";
import { DynamicModule, Module, Provider, Type } from "@nestjs/common";
import {
  MODULE_CLIENT_TOKEN,
  MODULE_CONNECTION_VARIABLE_TOKEN,
  MODULE_OPTIONS_TOKEN,
} from "./azure-storage-blob.constants";
import {
  AsyncModuleOptions,
  ExtraModuleOptions,
  ModuleOptions,
  ModuleOptionsFactory,
} from "./azure-storage-blob.interface";
import { AzureStorageBlobService } from "./azure-storage-blob.service";

@Module({
  providers: [AzureStorageBlobService],
  exports: [AzureStorageBlobService],
})
export class AzureStorageBlobModule {
  static register(
    options: ModuleOptions,
    extras?: ExtraModuleOptions,
  ): DynamicModule {
    return {
      module: AzureStorageBlobModule,
      providers: [
        { provide: MODULE_OPTIONS_TOKEN, useValue: options },
        {
          provide: MODULE_CLIENT_TOKEN,
          useFactory: () => this.createClient(options),
          scope: extras?.scope,
        },
      ],
      exports: [MODULE_CLIENT_TOKEN, MODULE_OPTIONS_TOKEN],
      global: extras?.global,
    };
  }

  static registerAsync(
    options: AsyncModuleOptions,
    extras?: ExtraModuleOptions,
  ): DynamicModule {
    const provider: Provider = {
      provide: MODULE_CLIENT_TOKEN,
      useFactory: (options: ModuleOptions) => this.createClient(options),
      inject: [MODULE_OPTIONS_TOKEN],
      scope: extras?.scope,
    };

    return {
      imports: options.imports,
      module: AzureStorageBlobModule,
      providers: [...this.createAsyncProviders(options), provider],
      exports: [MODULE_CLIENT_TOKEN, MODULE_OPTIONS_TOKEN],
      global: extras?.global,
    };
  }

  private static createAsyncProviders(
    optionsAsync: AsyncModuleOptions,
  ): Provider[] {
    if (optionsAsync.useExisting || optionsAsync.useFactory) {
      return [this.createAsyncOptionsProvider(optionsAsync)];
    }

    if (optionsAsync.useClass) {
      return [
        { provide: optionsAsync.useClass, useClass: optionsAsync.useClass },
        this.createAsyncOptionsProvider(optionsAsync),
      ];
    }

    throw new Error(
      "One of useClass, useFactory or useExisting should be provided",
    );
  }

  private static createAsyncOptionsProvider(
    options: AsyncModuleOptions,
  ): Provider {
    if (options.useFactory) {
      return {
        provide: MODULE_OPTIONS_TOKEN,
        useFactory: options.useFactory,
        inject: options.inject,
      };
    }

    return {
      provide: MODULE_OPTIONS_TOKEN,
      useFactory: (optionsFactory: ModuleOptionsFactory) =>
        optionsFactory.createModuleOptions(),
      inject: [
        (options.useClass ?? options.useExisting) as Type<ModuleOptionsFactory>,
      ],
    };
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
