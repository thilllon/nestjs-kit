import { Inject, type ExecutionContext } from "@nestjs/common";
import type {
  BetterAuthRuntimeOptions,
  PrincipalReading,
} from "./auth-contracts.js";
import { BetterAuthConfigurationError } from "./auth-errors.js";
import {
  getBetterAuthOptionsToken,
  INSTANCE_REGISTRY,
  MOUNT_COORDINATOR,
  PRINCIPAL_READINGS,
  REQUEST_SCOPE,
  ROUTE_PLANNER,
  TRANSPORT_REGISTRY,
} from "./auth-tokens.js";
import type {
  AuthLike,
  AuthPrincipal,
  RegisteredAuth,
  SessionOf,
} from "./auth-types.js";
import { derivedScope } from "./bridge-client.js";
import type { InstanceRegistry } from "./instance-registry.js";
import type { MountCoordinator } from "./mount-coordinator.js";
import type { PrincipalReadings } from "./principal-readings.js";
import type { RequestScope } from "./request-scope.js";
import type { RoutePlanner } from "./route-planner.js";
import { readCurrentSession } from "./session-principal.js";
import type { TransportRegistry } from "./transport-registry.js";

export class BetterAuthService<A extends AuthLike = RegisteredAuth> {
  readonly name: string;
  readonly instance: A;
  readonly api: A["api"];
  readonly #context: Promise<Awaited<A["$context"]>>;

  constructor(
    @Inject(getBetterAuthOptionsToken()) options: BetterAuthRuntimeOptions<A>,
    @Inject(INSTANCE_REGISTRY) private readonly registry: InstanceRegistry,
    @Inject(REQUEST_SCOPE) private readonly scope: RequestScope,
    @Inject(PRINCIPAL_READINGS) private readonly readings: PrincipalReadings,
    @Inject(ROUTE_PLANNER) private readonly planner: RoutePlanner,
    @Inject(TRANSPORT_REGISTRY) private readonly transports: TransportRegistry,
    @Inject(MOUNT_COORDINATOR) private readonly coordinator: MountCoordinator,
  ) {
    const registration = registry
      .registrations()
      .find((value) => value.options === options);
    if (!registration) {
      throw new BetterAuthConfigurationError(
        "UNKNOWN_INSTANCE",
        "The service options have no registered instance.",
      );
    }
    this.name = registration.name;
    this.instance = options.auth;
    this.api = options.auth?.api;
    this.#context = options.auth?.$context as Promise<Awaited<A["$context"]>>;
  }

  context(): Promise<Awaited<A["$context"]>> {
    return this.#context;
  }

  mount():
    | {
        readonly basePath: string;
        readonly bodyLimit: number;
        readonly platform: string;
      }
    | undefined {
    const binding = this.coordinator.binding(this.name);
    const platform = this.coordinator.platform;
    return binding && platform
      ? {
          basePath: binding.basePath,
          bodyLimit: binding.bodyLimit,
          platform: platform.id,
        }
      : undefined;
  }

  getPrincipal(): Promise<AuthPrincipal | null> {
    const reading = this.readings.current();
    return Promise.resolve(
      this.readings.project(reading, {
        site: "BetterAuthService.getPrincipal",
        project: (principal) => principal,
      }),
    );
  }

  getSession(): Promise<SessionOf<A> | null> {
    return Promise.resolve(readCurrentSession<SessionOf<A>>(this.readings));
  }

  principalFor(context: ExecutionContext): PrincipalReading {
    const plan = this.planner.forContext(context);
    const transport = this.transports.find(context);
    const lineage = transport?.lineage?.(context);
    const call =
      plan.access !== "public" && plan.access !== "inherit" && transport
        ? this.transports.describe(context, transport)
        : undefined;
    return this.readings.read({
      args: context.getArgs(),
      plan,
      call,
      lineage,
      beforeGuard: true,
    });
  }

  headersFrom(platformRequest: unknown): Headers {
    const accessor = this.coordinator.platform?.requests;
    if (!accessor?.isRequest(platformRequest)) {
      throw BetterAuthConfigurationError.atRequest(
        "NO_HTTP_REQUEST",
        "headersFrom needs a request from the selected HTTP platform.",
      );
    }
    const entry = this.registry.get(this.name);
    const headers = new Headers(accessor.headers(platformRequest));
    for (const name of [...headers.keys()]) {
      if (
        name.startsWith(":") ||
        name.startsWith("x-nsba-ip-") ||
        name === entry.bridge.clientIpHeader?.toLowerCase()
      ) {
        headers.delete(name);
      }
    }
    const clientIp = accessor.clientIp(platformRequest);
    if (entry.bridge.clientIpHeader && clientIp !== null) {
      headers.set(entry.bridge.clientIpHeader, clientIp);
    }
    return headers;
  }

  forwardForeignCookies<T>(fn: () => Promise<T>): Promise<T> {
    const outer = this.scope.current();
    if (!outer?.plan?.forwardDirectCalls) {
      throw BetterAuthConfigurationError.atRequest(
        "FORWARDING_NOT_DECLARED",
        "Declare cookie forwarding on the active handler before forwarding foreign credentials.",
        { hint: "Use @ForwardAuthCookies() on a guarded handler." },
      );
    }
    return this.scope.run(
      derivedScope(this.scope, {
        get cookies() {
          return outer.view.cookies;
        },
        get inbound() {
          return outer.view.inbound;
        },
        get internal() {
          return outer.view.internal;
        },
        forward: "any",
      }),
      fn,
    );
  }

  withoutCookies<T>(fn: () => Promise<T>): Promise<T> {
    const outer = this.scope.current();
    return this.scope.run(
      derivedScope(this.scope, {
        cookies: null,
        forward: "none",
        get inbound() {
          return outer?.view.inbound;
        },
        get internal() {
          return outer?.view.internal ?? false;
        },
      }),
      fn,
    );
  }

  runOutsideScope<T>(fn: () => Promise<T>): Promise<T> {
    return this.scope.exit(fn);
  }
}
