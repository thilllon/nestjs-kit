import type {
  DynamicModule,
  InjectionToken,
  Provider,
  Type,
} from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import type {
  AuthTransport,
  BetterAuthAppOptions,
  BetterAuthModuleAsyncOptions,
  BetterAuthModuleOptions,
  BetterAuthRuntimeOptions,
  BetterAuthStaticOptions,
  ExtensionDefinition,
  ExtensionRef,
  HttpPlatform,
  PrincipalSource,
} from "./auth-contracts.js";
import { BetterAuthCoreModule } from "./auth-core-module.js";
import { BetterAuthConfigurationError } from "./auth-errors.js";
import { BetterAuthGuard } from "./auth-guard.js";
import { BetterAuthScopeInterceptor } from "./auth-scope-interceptor.js";
import { BetterAuthService } from "./auth-service.js";
import {
  getBetterAuthHandleToken,
  getBetterAuthInstanceToken,
  getBetterAuthOptionsToken,
  getBetterAuthServiceToken,
  getExtensionToken,
  getPrincipalSourcesToken,
  INSTANCE_REGISTRY,
  MOUNT_COORDINATOR,
  PLATFORMS,
  PRINCIPAL_READINGS,
  REQUEST_SCOPE,
  ROUTE_PLANNER,
  TRANSPORT_REGISTRY,
  TRANSPORTS,
} from "./auth-tokens.js";
import type { AuthLike } from "./auth-types.js";
import { EXTENSION_DEFINITION } from "./bridge-protocol.js";
import { httpTransport } from "./http-transport.js";
import type {
  InstanceRegistration,
  InstanceRegistry,
} from "./instance-registry.js";
import type { MountCoordinator } from "./mount-coordinator.js";
import type { PrincipalReadings } from "./principal-readings.js";
import type { RequestScope } from "./request-scope.js";
import type { RoutePlanner } from "./route-planner.js";
import { sessionPrincipal } from "./session-principal.js";
import type { TransportRegistry } from "./transport-registry.js";

export function defineExtension<T>(
  definition: Omit<ExtensionDefinition<T>, typeof EXTENSION_DEFINITION>,
): ExtensionDefinition<T> {
  return { ...definition, [EXTENSION_DEFINITION]: true };
}
export function defineHttpPlatform<P extends HttpPlatform>(platform: P): P {
  return platform;
}
export function defineTransport<T extends AuthTransport>(transport: T): T {
  return transport;
}

const STATIC_KEYS = [
  "name",
  "global",
  "globalGuard",
  "globalScope",
  "principals",
  "platforms",
  "transports",
] as const;
export function moduleDefinition(
  module: Type,
  definition: (
    | BetterAuthModuleOptions<AuthLike>
    | BetterAuthModuleAsyncOptions<AuthLike>
  ) &
    BetterAuthAppOptions,
  async: boolean,
): DynamicModule {
  const name = definition.name || "default";
  const providers: Provider[] = [];
  const imports: NonNullable<DynamicModule["imports"]> = [BetterAuthCoreModule];
  const exports: NonNullable<DynamicModule["exports"]> = [];
  const registrationToken = Symbol(`registration:${name}`);
  const staticOptions: BetterAuthStaticOptions = {
    name,
    global: definition.global,
    globalGuard: definition.globalGuard,
    globalScope: definition.globalScope,
    principals: definition.principals,
  };
  const appOptions: BetterAuthAppOptions = {
    platforms: definition.platforms,
    transports: definition.transports,
  };
  const optionsToken = getBetterAuthOptionsToken(name);
  if (async) {
    const factory = definition as BetterAuthModuleAsyncOptions<AuthLike>;
    imports.push(...(factory.imports ?? []));
    providers.push({
      provide: optionsToken,
      inject: [...(factory.inject ?? [])],
      useFactory: async (...deps: unknown[]) => {
        const options = await factory.useFactory(...deps);
        for (const key of STATIC_KEYS) {
          if (Object.hasOwn(options, key)) {
            throw new BetterAuthConfigurationError(
              "STATIC_OPTION_IN_FACTORY",
              `'${key}' was returned from useFactory.`,
              `Pass '${key}' next to useFactory in forRootAsync().`,
            );
          }
        }
        return options;
      },
    });
  } else {
    const runtime = { ...definition } as Record<string, unknown>;
    for (const key of STATIC_KEYS) {
      delete runtime[key];
    }
    providers.push({ provide: optionsToken, useValue: runtime });
  }

  function extensions<T>(
    point: "platforms" | "transports" | "principals",
    refs: readonly ExtensionRef<T>[],
  ): InjectionToken[] {
    return refs.map((ref, index) => {
      const token = getExtensionToken(point, name, index);
      if (typeof ref === "function") {
        providers.push({ provide: token, useClass: ref as Type<T> });
      } else if (
        ref &&
        typeof ref === "object" &&
        Reflect.get(ref, EXTENSION_DEFINITION) === true
      ) {
        const definition = ref as ExtensionDefinition<T>;
        imports.push(...(definition.imports ?? []));
        providers.push(...(definition.providers ?? []));
        if ("useClass" in definition.use) {
          providers.push({ provide: token, useClass: definition.use.useClass });
        } else if ("useExisting" in definition.use) {
          providers.push({
            provide: token,
            useExisting: definition.use.useExisting,
          });
        } else {
          providers.push({
            provide: token,
            useFactory: definition.use.useFactory,
            inject: [...(definition.use.inject ?? [])],
          });
        }
        exports.push(...(definition.exports ?? []));
      } else {
        providers.push({ provide: token, useValue: ref });
      }
      return token;
    });
  }

  const sourceTokens = extensions("principals", definition.principals ?? []);
  providers.push({
    provide: getPrincipalSourcesToken(name),
    inject: [optionsToken, ...sourceTokens],
    useFactory: (
      options: BetterAuthRuntimeOptions<AuthLike>,
      ...sources: PrincipalSource[]
    ) => {
      const builtIn = sessionPrincipal(
        options.session === false ? undefined : options.session,
      );
      return options.session === false ? sources : [...sources, builtIn];
    },
  });
  providers.push({
    provide: registrationToken,
    inject: [INSTANCE_REGISTRY, optionsToken, getPrincipalSourcesToken(name)],
    useFactory: (
      registry: InstanceRegistry,
      options: BetterAuthRuntimeOptions<AuthLike>,
      sources: PrincipalSource[],
    ) => registry.register(options, staticOptions, sources, appOptions),
  });
  providers.push({
    provide: getBetterAuthInstanceToken(name),
    inject: [registrationToken],
    useFactory: (registration: InstanceRegistration) => registration.instance,
  });
  providers.push({
    provide: getBetterAuthHandleToken(name),
    inject: [registrationToken],
    useFactory: (registration: InstanceRegistration) => registration.handle,
  });
  const serviceProvider: Provider = {
    provide: getBetterAuthServiceToken(name),
    inject: [
      registrationToken,
      INSTANCE_REGISTRY,
      REQUEST_SCOPE,
      PRINCIPAL_READINGS,
      ROUTE_PLANNER,
      TRANSPORT_REGISTRY,
      MOUNT_COORDINATOR,
    ],
    useFactory: (
      registration: InstanceRegistration,
      registry: InstanceRegistry,
      scope: RequestScope,
      readings: PrincipalReadings,
      planner: RoutePlanner,
      transports: TransportRegistry,
      mounts: MountCoordinator,
    ) =>
      new BetterAuthService(
        registration.options,
        registry,
        scope,
        readings,
        planner,
        transports,
        mounts,
      ),
  };
  if (name === "default") {
    providers.push(
      { ...serviceProvider, provide: BetterAuthService },
      {
        provide: getBetterAuthServiceToken(name),
        useExisting: BetterAuthService,
      },
    );
    exports.push(BetterAuthService);
    const platformTokens = extensions("platforms", definition.platforms ?? []);
    const transportTokens = extensions("transports", [
      ...(definition.transports ?? []),
      httpTransport(),
    ]);
    providers.push({
      provide: PLATFORMS,
      inject: [MOUNT_COORDINATOR, ...platformTokens],
      useFactory: (mounts: MountCoordinator, ...platforms: HttpPlatform[]) => {
        mounts.registerPlatforms(platforms);
        return platforms;
      },
    });
    providers.push({
      provide: TRANSPORTS,
      inject: [TRANSPORT_REGISTRY, ...transportTokens],
      useFactory: (
        registry: TransportRegistry,
        ...transports: AuthTransport[]
      ) => {
        registry.register(transports);
        return transports;
      },
    });
  } else {
    providers.push(serviceProvider);
  }
  if (definition.globalGuard ?? name === "default") {
    providers.push({ provide: APP_GUARD, useExisting: BetterAuthGuard });
  }
  if (name === "default" && (definition.globalScope ?? true)) {
    providers.push({
      provide: APP_INTERCEPTOR,
      useExisting: BetterAuthScopeInterceptor,
    });
  }
  exports.push(
    optionsToken,
    getBetterAuthInstanceToken(name),
    getBetterAuthHandleToken(name),
    getBetterAuthServiceToken(name),
  );
  return {
    module,
    global: definition.global ?? true,
    imports,
    providers,
    exports,
  };
}
