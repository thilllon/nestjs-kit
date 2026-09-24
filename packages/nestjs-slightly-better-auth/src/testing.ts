import type {
  CanActivate,
  ExecutionContext,
  INestApplication,
} from "@nestjs/common";
import type { TestingModuleBuilder } from "@nestjs/testing";
import { isObservable, lastValueFrom } from "rxjs";
import type {
  AuthorizationDecision,
  PolicyInvoker,
  PrincipalRequest,
  PrincipalResolver,
  PrincipalResult,
  PrincipalSource,
  TransportCall,
} from "./auth-contracts.js";
import { BetterAuthConfigurationError } from "./auth-errors.js";
import { ScopeCore } from "./auth-scope-interceptor.js";
import {
  GUARD_CORE,
  INSTANCE_REGISTRY,
  POLICY_INVOKER,
  PRINCIPAL_RESOLVER,
  REQUEST_SCOPE,
  ROUTE_PLANNER,
  SCOPE_CORE,
  TRANSPORT_REGISTRY,
} from "./auth-tokens.js";
import type { AuthLike, AuthPrincipal } from "./auth-types.js";
import { BRIDGE_HANDLE, type BridgeHandle } from "./bridge-protocol.js";
import type { InstanceRegistry } from "./instance-registry.js";
import {
  PrincipalReadings,
  stampedReading,
  stampResult,
  type ReadingInput,
} from "./principal-readings.js";
import {
  absent,
  authenticated,
  ChainPrincipalResolver,
} from "./principal-resolver.js";
import type { RequestScope } from "./request-scope.js";
import type { RoutePlanner } from "./route-planner.js";
import type { TransportRegistry } from "./transport-registry.js";

const TEST_APP = Symbol.for("nestjs-slightly-better-auth:test-app");
const TEST_APP_CLOSE = Symbol.for("nestjs-slightly-better-auth:test-app-close");
const TEST_OVERRIDES = Symbol.for("nestjs-slightly-better-auth:test-overrides");
const PLUGIN_ID = "nestjs-slightly-better-auth";
const TEST_PRINCIPAL_SOURCE = "nestjs-slightly-better-auth:test-principal";

type FixedPrincipal =
  | AuthPrincipal
  | null
  | ((call: TransportCall) => AuthPrincipal | null);
type Decide = (
  policyId: string,
  params: unknown,
  principal: AuthPrincipal,
) =>
  | AuthorizationDecision
  | undefined
  | Promise<AuthorizationDecision | undefined>;

interface TestOverrides {
  readonly principals: Map<string, FixedPrincipal>;
  readonly deciders: Decide[];
}

/**
 * TestingModuleBuilder keys overrides by token, so repeated helper calls share one provider and its configuration.
 * The configuration lives on the builder under a global symbol, so the ESM and CommonJS copies of this entry compose.
 */
function overridesOf(builder: TestingModuleBuilder): TestOverrides {
  let overrides = Reflect.get(builder, TEST_OVERRIDES) as
    | TestOverrides
    | undefined;
  if (!overrides) {
    overrides = { principals: new Map(), deciders: [] };
    Object.defineProperty(builder, TEST_OVERRIDES, { value: overrides });
  }
  return overrides;
}

/** Make app.close() run Nest's shutdown once, whoever calls it: initTestApp, a registered hook or the test. */
function closeOnce(app: INestApplication): () => Promise<void> {
  const existing = Reflect.get(app, TEST_APP_CLOSE) as
    | (() => Promise<void>)
    | undefined;
  if (existing) {
    return existing;
  }
  const close = app.close.bind(app);
  let pending: Promise<void> | undefined;
  const once = () => {
    pending ??= close();
    return pending;
  };
  Object.defineProperty(app, TEST_APP_CLOSE, { value: once });
  app.close = once;
  return once;
}

async function bridgeOf(auth: AuthLike): Promise<BridgeHandle | undefined> {
  const context = (await auth.$context) as {
    getPlugin?(id: string): unknown;
  };
  const plugin = context.getPlugin?.(PLUGIN_ID);
  return plugin && typeof plugin === "object"
    ? (Reflect.get(plugin, BRIDGE_HANDLE) as BridgeHandle | undefined)
    : undefined;
}

function registryOf(app: INestApplication): InstanceRegistry | undefined {
  try {
    return app.get<InstanceRegistry>(INSTANCE_REGISTRY, { strict: false });
  } catch {
    return undefined;
  }
}

/**
 * init() plus Fastify ready() when the adapter exposes it. Before init, closes the previous application that
 * initTestApp initialized for the same Better Auth instance and that is still bound to it: an instance binds
 * exclusively to one application (B06). A failed init() leaves its binding for the next application, which takes it
 * over with W_INSTANCE_TAKEN_OVER. app.close() becomes idempotent, and `closeWith` receives it: a per-test cleanup such as
 * Vitest's onTestFinished or node:test's t.after, or a list that a suite-level afterEach drains (Jest registers no hooks
 * while a test runs). Without `closeWith`, close the last application yourself. On Express, compile one TestingModule per application: a
 * second application of one container fails init() with APP_ADAPTER_CHANGED.
 */
export async function initTestApp<T extends INestApplication>(
  app: T,
  options: { closeWith?: (close: () => Promise<void>) => void } = {},
): Promise<T> {
  const close = closeOnce(app);
  const bridges: BridgeHandle[] = [];
  for (const registration of registryOf(app)?.registrations() ?? []) {
    const bridge = registration.instance
      ? await bridgeOf(registration.instance)
      : undefined;
    if (!bridge) {
      continue;
    }
    const previous = Reflect.get(bridge, TEST_APP) as
      | INestApplication
      | undefined;
    if (previous && previous !== app && bridge.state === "bound") {
      // initTestApp made previous.close() idempotent, so a registered close of the same app does nothing later.
      await previous.close();
    }
    Object.defineProperty(bridge, TEST_APP, {
      value: undefined,
      configurable: true,
      writable: true,
    });
    bridges.push(bridge);
  }
  await app.init();
  const server = (
    app.getHttpAdapter?.() as { getInstance?(): unknown } | undefined
  )?.getInstance?.() as { ready?: () => unknown } | undefined;
  if (typeof server?.ready === "function") {
    await server.ready();
  }
  for (const bridge of bridges) {
    Object.defineProperty(bridge, TEST_APP, {
      value: app,
      configurable: true,
      writable: true,
    });
  }
  options.closeWith?.(close);
  return app;
}

/** Real session headers for `userId` through Better Auth's testUtils() plugin, which the instance must include. */
export async function authHeadersFor(
  auth: AuthLike,
  userId: string,
): Promise<Headers> {
  const context = (await auth.$context) as {
    test?: { getAuthHeaders?(options: { userId: string }): Promise<Headers> };
  };
  if (typeof context.test?.getAuthHeaders !== "function") {
    throw new BetterAuthConfigurationError(
      "TEST_UTILS_MISSING",
      "authHeadersFor requires Better Auth's testUtils() plugin on the instance.",
      "Add testUtils() from better-auth/plugins to the test instance.",
    );
  }
  return context.test.getAuthHeaders({ userId });
}

/**
 * Replace principal resolution for one instance (default: 'default') without Better Auth I/O. Acceptance, the
 * origin check and policies still run. A policy's re-classification read of a generic 401 answers absent,
 * because the request carries no session; other instances keep the real resolver.
 */
export function overridePrincipal(
  builder: TestingModuleBuilder,
  principal: FixedPrincipal,
  options: { instance?: string } = {},
): TestingModuleBuilder {
  const configured = overridesOf(builder).principals;
  configured.set(options.instance || "default", principal);
  builder.overrideProvider(PRINCIPAL_RESOLVER).useFactory({
    inject: [INSTANCE_REGISTRY, REQUEST_SCOPE, TRANSPORT_REGISTRY],
    factory: (
      instances: InstanceRegistry,
      scope: RequestScope,
      transports: TransportRegistry,
    ): PrincipalResolver => {
      const real = new ChainPrincipalResolver(instances, scope, transports);
      return {
        resolve(call, request): Promise<PrincipalResult> {
          if (!configured.has(request.auth.name)) {
            return real.resolve(call, request);
          }
          if (request.reclassify) {
            return Promise.resolve(absent());
          }
          const fixed = configured.get(request.auth.name);
          const value = typeof fixed === "function" ? fixed(call) : fixed;
          return Promise.resolve(value ? authenticated(value) : absent());
        },
      };
    },
  });
  return builder;
}

/**
 * Replace the policy invoker: `decide` answers per requirement, and undefined runs the real policy. Acceptance,
 * the delegation gate, the origin check and the decision memo still run. Later calls are consulted after earlier ones.
 */
export function overrideDecisions(
  builder: TestingModuleBuilder,
  decide: Decide,
): TestingModuleBuilder {
  const configured = overridesOf(builder).deciders;
  configured.push(decide);
  const invoker: PolicyInvoker = {
    async invoke(policy, params, context) {
      for (const decider of configured) {
        const decision = await decider(policy.id, params, context.principal);
        if (decision !== undefined) {
          return decision;
        }
      }
      return policy.evaluate(params, context);
    },
  };
  builder.overrideProvider(POLICY_INVOKER).useValue(invoker);
  return builder;
}

/** A principal source that answers a fixed principal (or null for absent), for test module composition. */
export function testPrincipal(
  principal: AuthPrincipal | ((req: PrincipalRequest) => AuthPrincipal | null),
  options: {
    kinds?: readonly string[];
    acceptance?: "default" | "explicit";
    delegates?: boolean;
  } = {},
): PrincipalSource {
  const fixed = typeof principal === "function" ? undefined : principal;
  const id = fixed?.source ?? TEST_PRINCIPAL_SOURCE;
  const kinds = options.kinds ?? (fixed ? [fixed.kind] : ["session"]);
  return {
    id,
    kinds: kinds as PrincipalSource["kinds"],
    acceptance: options.acceptance ?? "default",
    delegates: options.delegates ?? Boolean(fixed?.delegation),
    async resolve(request) {
      const value =
        typeof principal === "function" ? principal(request) : principal;
      return value
        ? authenticated({ ...value, source: id } as AuthPrincipal)
        : absent();
    },
  };
}

/**
 * Publish a principal for this invocation from a hand-written guard. The stamp lives on ctx.getArgs() and its
 * object elements. Readers accept it from the same args array (WS, RPC and GraphQL share it between guards and
 * interceptors) or from another array with the same elements when at least two elements are objects (an HTTP request
 * and its response); a lone shared element such as a socket never identifies an invocation. Pass `instance` for
 * handlers of a named instance.
 */
export function stampPrincipal(
  context: ExecutionContext,
  principal: AuthPrincipal | null,
  options: { instance?: string } = {},
): void {
  stampResult(
    context.getArgs(),
    options.instance || "default",
    principal ? authenticated(principal) : absent(),
  );
}

class StampFirstReadings extends PrincipalReadings {
  override read(input: ReadingInput) {
    const stamped =
      input.plan && input.plan.access !== "public"
        ? stampedReading(input.args, input.plan.instance)
        : undefined;
    return stamped ?? super.read(input);
  }
}

function planInstance(planner: RoutePlanner, context: ExecutionContext) {
  try {
    return planner.forContext(context).instance;
  } catch {
    return "default";
  }
}

/**
 * Replace the guard and scope bodies everywhere with one override each of GUARD_CORE and SCOPE_CORE: the APP_GUARD
 * alias and every @UseBetterAuth()/@UseGuards(BetterAuthGuard) site delegate to the same collaborator, which
 * overrideProvider(BetterAuthGuard) plus overrideGuard(BetterAuthGuard) cannot achieve. With `{ principal }` the
 * stand-in stamps the principal (for the handler's instance) and allows; with a CanActivate, that guard runs as the
 * whole guard body and may call stampPrincipal(); an object with a canActivate method is always treated as a guard,
 * even when it also has a `principal` property. The stand-in interceptor opens the same transport-described scope
 * as the real one, reading the test stamp first, so readers and BetterAuthService perform no Better Auth I/O.
 */
export function overrideAuthGuard(
  builder: TestingModuleBuilder,
  impl:
    | CanActivate
    | {
        principal:
          | AuthPrincipal
          | null
          | ((ctx: ExecutionContext) => AuthPrincipal | null);
      },
): TestingModuleBuilder {
  builder.overrideProvider(GUARD_CORE).useFactory({
    inject: [ROUTE_PLANNER],
    factory: (planner: RoutePlanner) => ({
      async canActivate(context: ExecutionContext): Promise<boolean> {
        // A CanActivate may hold its own `principal` field; its canActivate always runs.
        if (typeof (impl as Partial<CanActivate>).canActivate === "function") {
          const result = (impl as CanActivate).canActivate(context);
          return isObservable(result) ? lastValueFrom(result) : result;
        }
        const { principal } = impl as {
          principal:
            | AuthPrincipal
            | null
            | ((ctx: ExecutionContext) => AuthPrincipal | null);
        };
        const value =
          typeof principal === "function" ? principal(context) : principal;
        stampResult(
          context.getArgs(),
          planInstance(planner, context),
          value ? authenticated(value) : absent(),
        );
        return true;
      },
    }),
  });
  builder.overrideProvider(SCOPE_CORE).useFactory({
    inject: [
      INSTANCE_REGISTRY,
      ROUTE_PLANNER,
      TRANSPORT_REGISTRY,
      REQUEST_SCOPE,
    ],
    factory: (
      instances: InstanceRegistry,
      planner: RoutePlanner,
      transports: TransportRegistry,
      scope: RequestScope,
    ) =>
      new ScopeCore(
        instances,
        planner,
        transports,
        scope,
        new StampFirstReadings(scope),
      ),
  });
  return builder;
}
