import {
  Global,
  Inject,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  type OnModuleInit,
} from "@nestjs/common";
import {
  DiscoveryModule,
  DiscoveryService,
  HttpAdapterHost,
  MetadataScanner,
  ModuleRef,
  Reflector,
  ApplicationConfig,
} from "@nestjs/core";
import {
  AuthorizationEvaluator,
  DefaultPolicyInvoker,
} from "./authorization-evaluator.js";
import { BetterAuthGuard, GuardCore } from "./auth-guard.js";
import {
  BetterAuthScopeInterceptor,
  ScopeCore,
} from "./auth-scope-interceptor.js";
import { BetterAuthConfigurationError } from "./auth-errors.js";
import type { PolicyInvoker, PrincipalResolver } from "./auth-contracts.js";
import {
  GUARD_CORE,
  INSTANCE_REGISTRY,
  MOUNT_COORDINATOR,
  POLICY_INVOKER,
  POLICY_RESOLVER,
  PRINCIPAL_READINGS,
  PRINCIPAL_RESOLVER,
  REQUEST_SCOPE,
  ROUTE_PLANNER,
  SCOPE_CORE,
  TRANSPORT_REGISTRY,
} from "./auth-tokens.js";
import { BootValidator } from "./boot-validator.js";
import { BridgeClient } from "./bridge-client.js";
import { emptyHookTables, HookBinder } from "./hook-binder.js";
import { configurationIssue, InstanceRegistry } from "./instance-registry.js";
import { MountCoordinator } from "./mount-coordinator.js";
import { PolicyResolver } from "./policy-resolver.js";
import { PrincipalReadings } from "./principal-readings.js";
import { ChainPrincipalResolver } from "./principal-resolver.js";
import { RequestScope } from "./request-scope.js";
import { RoutePlanner } from "./route-planner.js";
import { TransportRegistry } from "./transport-registry.js";

const EVALUATOR = Symbol("authorization-evaluator");
const exports = [
  INSTANCE_REGISTRY,
  REQUEST_SCOPE,
  PRINCIPAL_READINGS,
  MOUNT_COORDINATOR,
  POLICY_RESOLVER,
  ROUTE_PLANNER,
  TRANSPORT_REGISTRY,
  PRINCIPAL_RESOLVER,
  POLICY_INVOKER,
  GUARD_CORE,
  SCOPE_CORE,
  BetterAuthGuard,
  BetterAuthScopeInterceptor,
];

@Global()
@Module({
  imports: [DiscoveryModule],
  providers: [
    MetadataScanner,
    { provide: REQUEST_SCOPE, useFactory: () => new RequestScope() },
    {
      provide: INSTANCE_REGISTRY,
      inject: [REQUEST_SCOPE],
      useFactory: (scope: RequestScope) => new InstanceRegistry(scope),
    },
    {
      provide: PRINCIPAL_READINGS,
      inject: [REQUEST_SCOPE],
      useFactory: (scope: RequestScope) => new PrincipalReadings(scope),
    },
    { provide: TRANSPORT_REGISTRY, useFactory: () => new TransportRegistry() },
    {
      provide: POLICY_RESOLVER,
      inject: [ModuleRef],
      useFactory: (ref: ModuleRef) => new PolicyResolver(ref),
    },
    {
      provide: ROUTE_PLANNER,
      inject: [INSTANCE_REGISTRY, POLICY_RESOLVER, TRANSPORT_REGISTRY],
      useFactory: (
        instances: InstanceRegistry,
        policies: PolicyResolver,
        transports: TransportRegistry,
      ) => new RoutePlanner(instances, policies, transports),
    },
    {
      provide: MOUNT_COORDINATOR,
      inject: [HttpAdapterHost, INSTANCE_REGISTRY, REQUEST_SCOPE],
      useFactory: (
        host: HttpAdapterHost,
        instances: InstanceRegistry,
        scope: RequestScope,
      ) => new MountCoordinator(host, instances, scope),
    },
    {
      provide: PRINCIPAL_RESOLVER,
      inject: [INSTANCE_REGISTRY, REQUEST_SCOPE, TRANSPORT_REGISTRY],
      useFactory: (
        instances: InstanceRegistry,
        scope: RequestScope,
        transports: TransportRegistry,
      ) => new ChainPrincipalResolver(instances, scope, transports),
    },
    { provide: POLICY_INVOKER, useFactory: () => new DefaultPolicyInvoker() },
    {
      provide: EVALUATOR,
      inject: [
        POLICY_RESOLVER,
        POLICY_INVOKER,
        PRINCIPAL_RESOLVER,
        REQUEST_SCOPE,
      ],
      useFactory: (
        policies: PolicyResolver,
        invoker: PolicyInvoker,
        resolver: PrincipalResolver,
        scope: RequestScope,
      ) => new AuthorizationEvaluator(policies, invoker, resolver, scope),
    },
    {
      provide: GUARD_CORE,
      inject: [
        INSTANCE_REGISTRY,
        ROUTE_PLANNER,
        TRANSPORT_REGISTRY,
        PRINCIPAL_RESOLVER,
        EVALUATOR,
        REQUEST_SCOPE,
        PRINCIPAL_READINGS,
      ],
      useFactory: (
        instances: InstanceRegistry,
        planner: RoutePlanner,
        transports: TransportRegistry,
        resolver: PrincipalResolver,
        evaluator: AuthorizationEvaluator,
        scope: RequestScope,
        readings: PrincipalReadings,
      ) =>
        new GuardCore(
          instances,
          planner,
          transports,
          resolver,
          evaluator,
          scope,
          readings,
        ),
    },
    {
      provide: SCOPE_CORE,
      inject: [
        INSTANCE_REGISTRY,
        ROUTE_PLANNER,
        TRANSPORT_REGISTRY,
        REQUEST_SCOPE,
        PRINCIPAL_READINGS,
      ],
      useFactory: (
        instances: InstanceRegistry,
        planner: RoutePlanner,
        transports: TransportRegistry,
        scope: RequestScope,
        readings: PrincipalReadings,
      ) => new ScopeCore(instances, planner, transports, scope, readings),
    },
    BetterAuthGuard,
    BetterAuthScopeInterceptor,
    HookBinder,
    BridgeClient,
    {
      provide: BootValidator,
      inject: [
        DiscoveryService,
        MetadataScanner,
        Reflector,
        ModuleRef,
        ApplicationConfig,
        INSTANCE_REGISTRY,
        ROUTE_PLANNER,
        POLICY_RESOLVER,
        TRANSPORT_REGISTRY,
        MOUNT_COORDINATOR,
      ],
      useFactory: (
        discovery: DiscoveryService,
        scanner: MetadataScanner,
        reflector: Reflector,
        moduleRef: ModuleRef,
        appConfig: ApplicationConfig,
        instances: InstanceRegistry,
        planner: RoutePlanner,
        policies: PolicyResolver,
        transports: TransportRegistry,
        mounts: MountCoordinator,
      ) =>
        new BootValidator(
          discovery,
          scanner,
          reflector,
          moduleRef,
          appConfig,
          instances,
          planner,
          policies,
          transports,
          mounts,
        ),
    },
  ],
  exports,
})
export class BetterAuthCoreModule
  implements OnModuleInit, OnApplicationBootstrap, OnApplicationShutdown
{
  #initialization: Promise<void> | undefined;
  #ready = false;

  constructor(
    @Inject(INSTANCE_REGISTRY) private readonly instances: InstanceRegistry,
    @Inject(REQUEST_SCOPE) private readonly scope: RequestScope,
    @Inject(TRANSPORT_REGISTRY) private readonly transports: TransportRegistry,
    @Inject(MOUNT_COORDINATOR) private readonly mounts: MountCoordinator,
    @Inject(HookBinder) private readonly hooks: HookBinder,
    @Inject(BridgeClient) private readonly bridges: BridgeClient,
    @Inject(BootValidator) private readonly validator: BootValidator,
  ) {}

  onModuleInit(): Promise<void> {
    if (!this.instances.begin(this.mounts.adapter)) {
      return this.#initialization ?? Promise.resolve();
    }
    this.#initialization = this.initialize();
    return this.#initialization;
  }

  private async initialize(): Promise<void> {
    const issues: BetterAuthConfigurationError[] = [];
    await this.instances.initialize(issues);
    const hooks = this.hooks.discover(this.instances, issues);
    for (const entry of this.instances.list()) {
      const tables = hooks.get(entry.name) ?? emptyHookTables();
      const unbound = entry.bridge.unboundDispatches;
      const count =
        tables.before.length +
        tables.after.length +
        Object.values(tables.database).reduce(
          (sum, value) => sum + value.before.length + value.after.length,
          0,
        );
      try {
        const result = this.bridges.bind(entry, {
          owner: this.instances.owner,
          instance: entry.name,
          state: "initialized",
          current: () => this.scope.current()?.view,
          credentialHeaders: entry.credentialHeaders,
          ...tables,
          onDropped: (path) =>
            this.instances.logger.debug(
              `Direct auth call '${path}' used foreign credentials; cookies dropped for '${entry.name}'.`,
            ),
        });
        if (result.tookOverFrom) {
          this.instances.logger.warn(
            `W_INSTANCE_TAKEN_OVER: '${entry.name}' took over from never-bootstrapped '${result.tookOverFrom}'; that application fails at bootstrap if it is still initializing.`,
          );
        }
        if (unbound > 0 && count > 0) {
          this.instances.logger.warn(
            `W_CALLS_BEFORE_BIND: '${entry.name}': ${unbound} auth dispatches or database writes ran before Nest hooks; move seeding to onApplicationBootstrap.`,
          );
        }
      } catch (error) {
        issues.push(
          configurationIssue(
            error,
            "INSTANCE_ALREADY_BOUND",
            `Cannot bind '${entry.name}' to this application.`,
          ),
        );
      }
    }
    this.mounts.prepareAtInit(issues);
    this.mounts.resolve(issues);
    this.transports.setKit({ http: this.mounts.platform?.requests ?? null });
    await this.validator.validate(issues);
    if (issues.length) {
      const failure = new BetterAuthConfigurationError(
        "AUTH_BOOT_FAILED",
        `Authentication bootstrap failed:\n${issues.map((issue) => `[${issue.code}] ${issue.detail}${issue.hint ? ` Hint: ${issue.hint}` : ""}`).join("\n")}`,
        "Resolve every reported configuration problem before starting the application.",
      );
      Object.defineProperty(failure, "issues", {
        value: Object.freeze([...issues]),
        enumerable: true,
      });
      throw failure;
    }
    this.validator.summary(hooks);
    await this.mounts.mount();
    this.#ready = true;
  }

  onApplicationBootstrap(): void {
    if (this.#ready && this.instances.state !== "bootstrapped") {
      this.bridges.bootstrap();
      this.instances.state = "bootstrapped";
    }
  }

  onApplicationShutdown(): void {
    this.bridges.close();
    this.instances.reset();
    this.mounts.reset();
    this.#initialization = undefined;
    this.#ready = false;
  }
}
