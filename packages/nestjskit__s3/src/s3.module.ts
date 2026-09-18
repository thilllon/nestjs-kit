import { S3Service } from "./s3.service";
import { DynamicModule, Module, Provider, Type } from "@nestjs/common";

import type {
  AsyncModuleOptions,
  ExtraModuleOptions,
  ModuleOptions,
  ModuleOptionsFactory,
} from "./s3.interface";
import { getClientToken, getOptionsToken } from "./s3.utils";

@Module({})
export class S3Module {
  static register(
    options: ModuleOptions,
    extras?: ExtraModuleOptions,
  ): DynamicModule {
    const optionsProvider: Provider = {
      provide: getOptionsToken(extras?.alias),
      useValue: options,
    };

    const clientProvider: Provider = {
      provide: getClientToken(extras?.alias),
      useFactory: () => this.createClient(options),
    };

    return {
      module: S3Module,
      providers: [optionsProvider, clientProvider],
      exports: [optionsProvider, clientProvider],
      global: extras?.global,
    };
  }

  static registerAsync(
    options: AsyncModuleOptions,
    extras?: ExtraModuleOptions,
  ): DynamicModule {
    const clientProvider: Provider = {
      provide: getClientToken(extras?.alias),
      useFactory: (options: ModuleOptions) => this.createClient(options),
      inject: [getOptionsToken(extras?.alias)],
    };
    const asyncProviders = this.createAsyncProviders(options, extras);

    return {
      module: S3Module,
      imports: options.imports,
      providers: [clientProvider, ...asyncProviders],
      exports: [clientProvider, ...asyncProviders],
      global: extras?.global,
    };
  }

  private static createAsyncProviders(
    options: AsyncModuleOptions,
    extras?: ExtraModuleOptions,
  ): Provider[] {
    if (options.useClass) {
      return [
        { provide: options.useClass, useClass: options.useClass },
        this.createAsyncOptionsProvider(options, extras),
      ];
    }

    if (options.useExisting || options.useFactory) {
      return [this.createAsyncOptionsProvider(options, extras)];
    }

    throw new Error(
      "Invalid configuration. One of useClass, useExisting or useFactory must be defined.",
    );
  }

  private static createAsyncOptionsProvider(
    options: AsyncModuleOptions,
    extras?: ExtraModuleOptions,
  ): Provider {
    if (options.useClass || options.useExisting) {
      return {
        provide: getOptionsToken(extras?.alias),
        async useFactory(
          optionsFactory: ModuleOptionsFactory,
        ): Promise<ModuleOptions> {
          return optionsFactory.create();
        },
        inject: [
          options.useClass || options.useExisting,
        ] as Type<ModuleOptionsFactory>[],
      };
    }

    if (options.useFactory) {
      return {
        provide: getOptionsToken(extras?.alias),
        useFactory: options.useFactory,
        inject: options.inject,
      };
    }

    throw new Error(
      "Invalid configuration. One of useClass, useExisting or useFactory must be defined.",
    );
  }

  private static createClient(options: ModuleOptions): S3Service {
    return new S3Service(options);
  }
}
