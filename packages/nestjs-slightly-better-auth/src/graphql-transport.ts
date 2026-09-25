import type { IncomingHttpHeaders } from "node:http";
import type { ExecutionContext } from "@nestjs/common";
import { IntrinsicException } from "@nestjs/common/exceptions/intrinsic.exception.js";
import { MetadataScanner } from "@nestjs/core";
import { ApplicationConfig } from "@nestjs/core/application-config.js";
import {
  Args,
  GRAPHQL_MODULE_OPTIONS,
  PARAM_ARGS_METADATA,
  RESOLVER_PROPERTY_METADATA,
  RESOLVER_REFERENCE_METADATA,
  RESOLVER_TYPE_METADATA,
  Query,
  ResolveField,
  ResolveReference,
} from "@nestjs/graphql";
import type {
  AuthTransport,
  BootAdvice,
  BootAdviceContext,
  ExtensionRef,
  RoutePlan,
  TransportCall,
  TransportKit,
  TransportValidationContext,
} from "./auth-contracts.js";
import {
  BetterAuthConfigurationError,
  AuthFailures,
  isConfigurationError,
} from "./auth-errors.js";
import type {
  AuthFailure,
  AuthGraphqlExtensions,
  BetterAuthInfrastructureError,
} from "./auth-errors.js";
import { BetterAuthGuard } from "./auth-guard.js";
import { BetterAuthScopeInterceptor } from "./auth-scope-interceptor.js";
import {
  AUTH_ENHANCER,
  ACCESS_METADATA,
  ACCEPT_PRINCIPALS_METADATA,
  REQUIREMENTS_METADATA,
} from "./auth-tokens.js";
import {
  graphqlArgs,
  graphqlInvocation,
  graphqlLineage,
  record,
} from "./graphql-lineage.js";
import { toWebHeaders, upgradeRequestUrl } from "./platform.js";

const MERCURIUS_AMBIENT = Symbol.for(
  "nestjs-slightly-better-auth:mercurius-ambient",
);
const MERCURIUS_UPGRADE = Symbol.for(
  "nestjs-slightly-better-auth:mercurius-upgrade",
);
export interface GraphqlTransportOptions {
  /** Case-insensitive connection-init credential keys; defaults to authorization and cookie. */
  connectionParamHeaders?: readonly string[];
  /**
   * Replaces socket credentials, preserving absent host and forwarded-host/proto headers.
   * Returning undefined presents no credentials: neither connectionParamHeaders nor the
   * upgrade request's credential headers are used.
   */
  subscriptionCredentials?: (
    connectionContext: unknown,
  ) => HeadersInit | undefined;
  /** Connection principal reuse; zero by default. Authoritative plans bypass the TTL. */
  subscriptionPrincipalTtlMs?: number;
  fieldResolverCoverage?: "error" | "warn" | "off";
  federationCoverage?: "error" | "warn" | "off";
}
export class BetterAuthGraphqlDenial extends IntrinsicException {
  readonly extensions: AuthGraphqlExtensions;

  constructor(failure: AuthFailure) {
    super(failure.message);
    this.extensions = {
      code: failure.code,
      statusCode: failure.status,
      ...(failure.reason ? { reason: failure.reason } : {}),
    };
  }
}
function internalExtensions(
  error: BetterAuthInfrastructureError | BetterAuthConfigurationError,
): AuthGraphqlExtensions {
  return {
    code: "INTERNAL_SERVER_ERROR",
    reason: isConfigurationError(error)
      ? "AUTH_MISCONFIGURED"
      : "AUTH_UNAVAILABLE",
    statusCode: 500,
  };
}
export class BetterAuthGraphqlInternalError extends Error {
  readonly extensions: AuthGraphqlExtensions;

  constructor(
    error: BetterAuthInfrastructureError | BetterAuthConfigurationError,
  ) {
    super("Internal server error", { cause: error });
    this.extensions = internalExtensions(error);
  }
}
export class BetterAuthGraphqlRepeatedInternalError extends IntrinsicException {
  readonly extensions: AuthGraphqlExtensions;

  constructor(
    error: BetterAuthInfrastructureError | BetterAuthConfigurationError,
  ) {
    super("Internal server error", { cause: error });
    this.extensions = internalExtensions(error);
  }
}
/** Keeps the upgrade request and its original browser headers across Mercurius operation spreads. */
export function mercuriusSubscriptionContext() {
  return (
    _connection: unknown,
    request: { headers: Record<string, unknown> },
  ): Record<string | symbol, unknown> => ({
    [MERCURIUS_UPGRADE]: request,
    [MERCURIUS_AMBIENT]: ambientHeaders(request),
  });
}
interface Upgrade {
  headers: IncomingHttpHeaders;
  url?: string;
  socket?: { encrypted?: boolean };
}
function upgrade(value: unknown): Upgrade | undefined {
  const candidate = record(value);
  return candidate && record(candidate.headers)
    ? (candidate as unknown as Upgrade)
    : undefined;
}
/**
 * The upgrade request of a graphql-ws `extra` ({ socket, request }) whose socket is a
 * WebSocket. Only the graphql-ws server creates that pair; parsed request data cannot carry
 * functions, so a client-sent header or field never selects the socket path. The socket's
 * state is deliberately ignored: a connection closing during authentication stays a socket
 * operation instead of turning into an unrecognized context.
 */
function graphqlWsUpgrade(value: unknown): Upgrade | undefined {
  const extra = record(value);
  const socket = record(extra?.socket);
  return socket &&
    typeof socket.send === "function" &&
    typeof socket.close === "function"
    ? upgrade(extra?.request)
    : undefined;
}
function ambientHeaders(request: unknown): Headers {
  const value = record(request);
  const raw = record(value?.raw) ?? value;
  // Mercurius copies connection-init values into missing request.headers keys.
  // Node rawHeaders retains the actual browser leg even after that mutation.
  const rawHeaders = raw?.rawHeaders;
  if (Array.isArray(rawHeaders)) {
    const headers = new Headers();
    for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
      if (
        typeof rawHeaders[index] === "string" &&
        typeof rawHeaders[index + 1] === "string"
      ) {
        headers.append(rawHeaders[index], rawHeaders[index + 1]);
      }
    }
    return headers;
  }
  return toWebHeaders((value?.headers ?? {}) as IncomingHttpHeaders);
}
/**
 * Mercurius assigns the route's Fastify reply to context.reply for HTTP operations. Its
 * subscription contexts carry the platform-recognized upgrade request inside a plain reply
 * object instead, so the reply's identity, not the request alone, marks an HTTP operation.
 */
function platformReply(http: TransportKit["http"], value: unknown): boolean {
  const request = record(value)?.request;
  if (http?.isRequest(request) !== true) {
    return false;
  }
  return http.responseFor ? http.responseFor(request) === value : true;
}
function carrierDetails(
  context: unknown,
  driver: "apollo" | "mercurius",
  http: TransportKit["http"],
) {
  const carrier = record(context) ?? {};
  const req = record(carrier.req);
  const extra = record(carrier.extra);
  // A positive platform answer keeps the HTTP path and its liveness check, before any socket
  // heuristic: a custom context can spread client data such as _connectionInit into its root.
  const httpRequest =
    driver === "apollo"
      ? http?.isRequest(req) === true ||
        http?.isRequest(extra?.request) === true
      : platformReply(http, carrier.reply);
  // Nest assigns the graphql-ws Context to context.req unless a custom context sets req. Its
  // server-created extra identifies it: graphql-ws sets connectionParams only for an object
  // connection_init payload, and an absent payload presents no connection credentials.
  const wsContext =
    driver === "apollo" && !httpRequest && graphqlWsUpgrade(req?.extra)
      ? req
      : undefined;
  const socket = httpRequest
    ? undefined
    : driver === "apollo"
      ? graphqlWsUpgrade(wsContext ? wsContext.extra : extra)
      : (upgrade(carrier[MERCURIUS_UPGRADE]) ??
        ("_connectionInit" in carrier
          ? (upgrade(carrier.request) ??
            upgrade(record(carrier.reply)?.request) ??
            upgrade(carrier.req))
          : undefined));
  const connection = wsContext ? req : carrier;
  const params = record(
    wsContext
      ? req?.connectionParams
      : (carrier.connectionParams ?? carrier._connectionInit),
  );
  const request =
    driver === "apollo"
      ? carrier.req
      : (record(carrier.reply)?.request ?? carrier.req);
  const ambient = () =>
    carrier[MERCURIUS_AMBIENT] instanceof Headers
      ? new Headers(carrier[MERCURIUS_AMBIENT])
      : ambientHeaders(socket);
  return { carrier, socket, connection, params, request, ambient };
}
class GraphqlTransport implements AuthTransport {
  readonly requires = { hostlessCalls: false };
  readonly connectionTtlMs: number;
  private kit?: TransportKit;
  private plans: {
    plan: RoutePlan;
    field: boolean;
    reference: boolean;
    target: object;
    method: string;
  }[] = [];
  private enhancerAdvice?: BootAdvice;
  private filterAdvice?: BootAdvice;

  constructor(
    readonly id: "apollo" | "mercurius",
    private readonly options: GraphqlTransportOptions,
  ) {
    this.connectionTtlMs = options.subscriptionPrincipalTtlMs ?? 0;
    if (!Number.isFinite(this.connectionTtlMs) || this.connectionTtlMs < 0) {
      throw new BetterAuthConfigurationError(
        "INVALID_SUBSCRIPTION_TTL",
        "subscriptionPrincipalTtlMs must be a finite nonnegative number",
      );
    }
  }

  handles(context: ExecutionContext): boolean {
    return context.getType<string>() === "graphql";
  }

  private reference(context: ExecutionContext): boolean {
    return (
      Reflect.getMetadata(RESOLVER_REFERENCE_METADATA, context.getHandler()) ===
      true
    );
  }

  defaultAccessFor(target: object, method: string): "inherit" | undefined {
    const handler = Reflect.get(
      Reflect.get(target, "prototype") ?? target,
      method,
    );
    return typeof handler === "function" &&
      !Reflect.getMetadata(RESOLVER_REFERENCE_METADATA, handler) &&
      Reflect.getMetadata(RESOLVER_PROPERTY_METADATA, handler)
      ? "inherit"
      : undefined;
  }

  lineage(context: ExecutionContext) {
    return {
      ...graphqlLineage(context.getArgs(), this.reference(context)),
      assertReadable: (args: readonly unknown[]) => {
        if (this.kit) {
          this.assertRequest(args, this.kit);
        }
      },
    };
  }

  private assertRequest(args: readonly unknown[], kit: TransportKit) {
    const details = carrierDetails(
      graphqlArgs(args).context,
      this.id,
      kit.http,
    );
    if (details.socket) {
      return details;
    }
    if (!kit.http?.isRequest(details.request)) {
      throw BetterAuthConfigurationError.atRequest(
        "GRAPHQL_CONTEXT_UNRECOGNIZED",
        "GraphQL context has no recognized platform or upgrade request",
        {
          hint: "Keep the native request at context.req or context.extra.request; use mercuriusSubscriptionContext() for Mercurius sockets.",
        },
      );
    }
    if (!kit.http.isLive(details.request)) {
      throw BetterAuthConfigurationError.atRequest(
        "GRAPHQL_CONTEXT_STALE_REQUEST",
        "GraphQL context contains a completed request",
        { hint: "Return a fresh context object for every operation." },
      );
    }
    return details;
  }

  describe(context: ExecutionContext, kit: TransportKit): TransportCall {
    this.kit = kit;
    const args = context.getArgs();
    const normalized = graphqlArgs(args);
    const initial = carrierDetails(normalized.context, this.id, kit.http);
    const key =
      !initial.socket && kit.http?.isRequest(initial.request)
        ? kit.http.key(initial.request)
        : normalized.context;
    const checked = () => this.assertRequest(args, kit);
    const headers = () => {
      const details = checked();
      if (!details.socket) {
        return kit.http!.headers(details.request);
      }
      const ambient = details.ambient();
      if (this.options.subscriptionCredentials) {
        // Keep callback errors outside the conversion boundary: application
        // programming failures are not malformed credential denials.
        const input = this.options.subscriptionCredentials(details.connection);
        let mapped: Headers;
        try {
          mapped = new Headers(input);
        } catch {
          // Web Headers errors embed rejected values, including server secrets.
          // Discard the exception entirely; never retain its message or cause.
          throw AuthFailures.rejected({
            status: 401,
            reason: "MALFORMED_CREDENTIALS",
          });
        }
        for (const name of ["host", "x-forwarded-host", "x-forwarded-proto"]) {
          const value = ambient.get(name);
          if (!mapped.has(name) && value !== null) {
            mapped.set(name, value);
          }
        }
        return mapped;
      }
      const credentials = new Headers(ambient);
      const allow = new Set(
        (
          this.options.connectionParamHeaders ?? ["authorization", "cookie"]
        ).map((name) => name.toLowerCase()),
      );
      for (const [name, value] of Object.entries(details.params ?? {})) {
        if (!allow.has(name.toLowerCase())) {
          continue;
        }
        if (typeof value !== "string" || /[\r\n\0]/.test(value)) {
          throw AuthFailures.rejected({
            status: 401,
            reason: "MALFORMED_CREDENTIALS",
          });
        }
        try {
          credentials.set(name, value);
        } catch {
          // One malformed selected credential rejects the whole extraction,
          // without falling back to another credential or exposing its value.
          throw AuthFailures.rejected({
            status: 401,
            reason: "MALFORMED_CREDENTIALS",
          });
        }
      }
      return credentials;
    };
    return {
      key,
      invocation: graphqlInvocation(args, this.reference(context)),
      lineage: this.lineage(context),
      ...(initial.socket
        ? { connection: initial.socket, principalTtlMs: this.connectionTtlMs }
        : {}),
      headers,
      get clientIp() {
        const details = checked();
        return details.socket ? null : kit.http!.clientIp(details.request);
      },
      get cookies() {
        const details = checked();
        return details.socket
          ? null
          : kit.http!.cookieSink(
              details.request,
              details.carrier.reply ??
                record(details.request)?.res ??
                kit.http!.responseFor?.(details.request),
            );
      },
      get request() {
        const details = checked();
        return details.socket
          ? { method: "GET", url: upgradeRequestUrl(details.socket) }
          : kit.http!.request(details.request);
      },
      param: (name) =>
        (this.reference(context)
          ? normalized.root?.[name]
          : normalized.args?.[name]) ??
        (!initial.socket && kit.http?.isRequest(initial.request)
          ? kit.http.param(initial.request, name)
          : undefined),
      get browser() {
        const details = checked();
        return details.socket
          ? {
              enforce: true,
              headers: details.ambient,
              url: upgradeRequestUrl(details.socket),
              key: details.socket,
            }
          : {
              enforce: normalized.info?.operation.operation === "mutation",
              headers: () => kit.http!.headers(details.request),
              url: kit.http!.request(details.request).url,
              key,
            };
      },
    };
  }

  toException(failure: AuthFailure): unknown {
    return new BetterAuthGraphqlDenial(failure);
  }

  toInternalException(
    error: BetterAuthInfrastructureError | BetterAuthConfigurationError,
    _context: ExecutionContext,
    info: { repeated: boolean },
  ): unknown {
    return info.repeated
      ? new BetterAuthGraphqlRepeatedInternalError(error)
      : new BetterAuthGraphqlInternalError(error);
  }

  validate(context: TransportValidationContext): void {
    const options = context.moduleRef.get<{
      driver?: object;
      context?: unknown;
      fieldResolverEnhancers?: string[];
    }>(GRAPHQL_MODULE_OPTIONS, { strict: false });
    const names: string[] = [];
    for (
      let driver = options.driver;
      typeof driver === "function";
      driver = Object.getPrototypeOf(driver)
    ) {
      names.push(driver.name);
    }
    if (
      names.some((name) =>
        name.startsWith(this.id === "apollo" ? "Mercurius" : "Apollo"),
      )
    ) {
      throw new BetterAuthConfigurationError(
        "GRAPHQL_DRIVER_MISMATCH",
        `${this.id} transport does not match ${names.join(" / ")}`,
      );
    }
    if (
      options.context !== undefined &&
      typeof options.context !== "function"
    ) {
      throw new BetterAuthConfigurationError(
        "GRAPHQL_STATIC_CONTEXT",
        "GraphQL context must be a function returning a fresh object",
        "context: ({ req }) => ({ req, loaders: createLoaders() })",
      );
    }
    class Probe {
      query() {}
      field() {}
      reference() {}
    }
    for (const [name, decorator, key] of [
      ["query", Query(() => String), RESOLVER_TYPE_METADATA],
      ["field", ResolveField(() => String), RESOLVER_PROPERTY_METADATA],
      ["reference", ResolveReference(), RESOLVER_REFERENCE_METADATA],
    ] as const) {
      decorator(
        Probe.prototype,
        name,
        Object.getOwnPropertyDescriptor(Probe.prototype, name)!,
      );
      if (!Reflect.getMetadata(key, Probe.prototype[name])) {
        throw new BetterAuthConfigurationError(
          "NEST_METADATA_KEY_CHANGED",
          `GraphQL metadata canary failed: ${key}`,
        );
      }
    }
    Args("probe", { type: () => String })(Probe.prototype, "query", 0);
    const argumentMetadata = record(
      Reflect.getMetadata(PARAM_ARGS_METADATA, Probe, "query"),
    );
    if (
      !argumentMetadata ||
      !Object.entries(argumentMetadata).some(
        ([key, value]) =>
          key.startsWith("3:") && record(value)?.data === "probe",
      )
    ) {
      throw new BetterAuthConfigurationError(
        "NEST_METADATA_KEY_CHANGED",
        "GraphQL argument metadata failed its parameter canary",
      );
    }
    const guards = options.fieldResolverEnhancers?.includes("guards") === true;
    const scanner = new MetadataScanner();
    this.plans = [];
    for (const wrapper of context.discovery.getProviders()) {
      const target = wrapper.metatype;
      if (!target?.prototype || wrapper.isAlias) {
        continue;
      }
      for (const method of scanner.getAllMethodNames(target.prototype)) {
        const handler = Reflect.get(target.prototype, method);
        const field =
          Reflect.getMetadata(RESOLVER_PROPERTY_METADATA, handler) === true;
        const reference =
          Reflect.getMetadata(RESOLVER_REFERENCE_METADATA, handler) === true;
        if (
          !field &&
          !reference &&
          !Reflect.getMetadata(RESOLVER_TYPE_METADATA, handler)
        ) {
          continue;
        }
        const metadata = record(
          Reflect.getMetadata(PARAM_ARGS_METADATA, target, method),
        );
        const inputs = reference
          ? []
          : Object.entries(metadata ?? {}).flatMap(([key, entry]) =>
              key.startsWith("3:") && typeof record(entry)?.data === "string"
                ? [String(record(entry)!.data)]
                : [],
            );
        context.claim(
          target,
          method,
          field || reference ? (guards ? "global" : "none") : "global",
          {
            code: reference
              ? "REFERENCE_RESOLVER_UNGUARDED"
              : field
                ? "FIELD_RESOLVER_UNGUARDED"
                : "GRAPHQL_OPERATION_UNGUARDED",
            hint: "Set fieldResolverEnhancers: ['guards', 'interceptors'], or declare @Public() where appropriate.",
            coverage: reference
              ? this.options.federationCoverage
              : field
                ? this.options.fieldResolverCoverage
                : "error",
            everyHandler: reference,
            inputs,
          },
        );
        this.plans.push({
          plan: context.planOf(target, method),
          field,
          reference,
          target,
          method,
        });
      }
    }
    const federation =
      names.some((name) => name.includes("Federation")) ||
      this.plans.some((entry) => entry.reference);
    const needsGuards = this.plans.some(
      (entry) => entry.field || entry.reference,
    );
    if (
      federation &&
      needsGuards &&
      !guards &&
      this.options.federationCoverage !== "off"
    ) {
      const message =
        "Federation field and reference resolvers require fieldResolverEnhancers: ['guards', 'interceptors']; this runs every global guard once per field invocation.";
      if (this.options.federationCoverage === "warn") {
        context.logger.warn(`FEDERATION_FIELD_GUARDS_REQUIRED: ${message}`);
      } else {
        throw new BetterAuthConfigurationError(
          "FEDERATION_FIELD_GUARDS_REQUIRED",
          message,
        );
      }
    }
    if (needsGuards && !options.fieldResolverEnhancers?.includes("filters")) {
      this.filterAdvice = {
        level: "warn",
        code: "W_FIELD_EXCEPTION_FILTERS_DISABLED",
        message:
          "Nested GraphQL errors bypass Nest exception filters and ERROR logging while fieldResolverEnhancers omits filters.",
        hint: "Include 'filters' with 'guards' in fieldResolverEnhancers to deliver nested authentication errors through Nest's exception pipeline; 'interceptors' enables per-field scopes.",
      };
    }
    if (needsGuards) {
      const config = context.moduleRef.get(ApplicationConfig, {
        strict: false,
      });
      const owned = new Set<unknown>([
        context.moduleRef.get(BetterAuthGuard, { strict: false }),
        context.moduleRef.get(BetterAuthScopeInterceptor, { strict: false }),
      ]);
      const names = [
        ...config.getGlobalGuards(),
        ...config.getGlobalInterceptors(),
      ]
        .filter(
          (value) =>
            !owned.has(value) &&
            !["guard", "scope"].includes(Reflect.get(value, AUTH_ENHANCER)),
        )
        .map((value) => value.constructor.name);
      if (names.length) {
        this.enhancerAdvice = {
          level: "warn",
          code: "W_FIELD_GUARDS_MULTIPLY_GLOBAL_ENHANCERS",
          message: `${names.join(", ")} run once per field-resolver invocation when their corresponding field enhancer is enabled: guards for global guards, interceptors for global interceptors.`,
          hint: "Use @SkipThrottle() or equivalent, move global guards to controllers, or use coverage: 'warn' behind an authenticating router.",
        };
      }
    }
  }

  advise(context: BootAdviceContext): readonly BootAdvice[] {
    const advice: BootAdvice[] = [
      this.enhancerAdvice,
      this.filterAdvice,
    ].filter((value): value is BootAdvice => value !== undefined);
    const entries = this.plans;
    const publicEntries = entries.filter(
      ({ plan, field }) =>
        !field && ["public", "optional"].includes(plan.access),
    );
    const inheriting = entries.filter(({ plan }) => plan.access === "inherit");
    if (publicEntries.length && inheriting.length) {
      advice.push({
        level: "warn",
        code: "W_FIELD_RESOLVER_INHERITS",
        message: `${inheriting
          .map(({ plan }) => plan.site)
          .slice(0, 20)
          .join(
            ", ",
          )} inherit readings from entry points including ${publicEntries
          .map(({ plan }) => plan.site)
          .slice(0, 20)
          .join(", ")}.`,
        hint: "Use @RequireAuth() and fieldResolverEnhancers: ['guards'] for sensitive fields.",
      });
    }
    for (const { plan } of inheriting) {
      if (
        plan.principalParams.some((param) =>
          entries.some((entry) =>
            [...entry.plan.accepts].some((kind) => kind !== param.kind),
          ),
        )
      ) {
        advice.push({
          level: "warn",
          code: "W_NESTED_PRINCIPAL_PARAM",
          message: `${plan.site} can inherit a different principal kind from another schema entry point.`,
          hint: "Use @CurrentPrincipal() and narrow p.kind, or declare field access and acceptance.",
        });
      }
    }
    const targets = new Set(
      entries.filter(({ field }) => field).map(({ target }) => target),
    );
    for (const target of targets) {
      if (
        [
          ACCESS_METADATA,
          ACCEPT_PRINCIPALS_METADATA,
          REQUIREMENTS_METADATA,
        ].some((key) => Reflect.hasMetadata(key, target))
      ) {
        advice.push({
          level: "info",
          code: "I_CLASS_METADATA_OPERATIONS_ONLY",
          message: `Class metadata excludes inherited fields ${entries
            .filter(
              (entry) =>
                entry.target === target && entry.plan.access === "inherit",
            )
            .map((entry) => entry.method)
            .join(", ")}; it applies to operations and reference resolvers ${
            entries
              .filter((entry) => entry.target === target && entry.reference)
              .map((entry) => entry.method)
              .join(", ") || "(none)"
          }.`,
        });
      }
    }
    if (
      !this.connectionTtlMs &&
      context.sources.some(
        (source) => source.effects?.consumesQuota || source.effects?.writes,
      )
    ) {
      advice.push({
        level: "warn",
        code: "W_QUOTA_PER_MESSAGE",
        message:
          "Each socket operation resolves quota-consuming or writing principal sources.",
        hint: "Consider subscriptionPrincipalTtlMs and its revocation delay.",
      });
    }
    return advice;
  }
}
export function apolloTransport(
  options: GraphqlTransportOptions = {},
): ExtensionRef<AuthTransport> {
  return new GraphqlTransport("apollo", options);
}
export function mercuriusTransport(
  options: GraphqlTransportOptions = {},
): ExtensionRef<AuthTransport> {
  return new GraphqlTransport("mercurius", options);
}
