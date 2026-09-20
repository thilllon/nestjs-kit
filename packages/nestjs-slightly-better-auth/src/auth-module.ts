import { Module, type DynamicModule } from "@nestjs/common";
import type {
  BetterAuthAppOptions,
  BetterAuthModuleAsyncOptions,
  BetterAuthModuleOptions,
  DefaultInstanceCheck,
  NoAppOptions,
} from "./auth-contracts.js";
import { moduleDefinition } from "./auth-module-definition.js";
import type { AuthLike, RegisteredAuth } from "./auth-types.js";

@Module({})
export class BetterAuthModule {
  static forRoot<A extends AuthLike = RegisteredAuth>(
    options: BetterAuthModuleOptions<A> &
      BetterAuthAppOptions & { name?: "default" } & DefaultInstanceCheck<A>,
  ): DynamicModule;
  static forRoot<A extends AuthLike>(
    options: BetterAuthModuleOptions<A> & { name: string } & NoAppOptions,
  ): DynamicModule;
  static forRoot<A extends AuthLike>(
    options: BetterAuthModuleOptions<A> & BetterAuthAppOptions,
  ): DynamicModule {
    return moduleDefinition(
      BetterAuthModule,
      options as BetterAuthModuleOptions<AuthLike> & BetterAuthAppOptions,
      false,
    );
  }

  static forRootAsync<A extends AuthLike = RegisteredAuth>(
    options: BetterAuthModuleAsyncOptions<A> &
      BetterAuthAppOptions & { name?: "default" },
  ): DynamicModule;
  static forRootAsync<A extends AuthLike>(
    options: BetterAuthModuleAsyncOptions<A> & { name: string } & NoAppOptions,
  ): DynamicModule;
  static forRootAsync<A extends AuthLike>(
    options: BetterAuthModuleAsyncOptions<A> & BetterAuthAppOptions,
  ): DynamicModule {
    return moduleDefinition(
      BetterAuthModule,
      options as BetterAuthModuleAsyncOptions<AuthLike> & BetterAuthAppOptions,
      true,
    );
  }
}
