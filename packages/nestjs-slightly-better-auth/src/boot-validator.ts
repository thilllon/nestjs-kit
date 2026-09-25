import {
  Controller,
  Get,
  Inject,
  Logger,
  RequestMethod,
  UseGuards,
  UseInterceptors,
  VERSION_NEUTRAL,
  VersioningType,
  type Type,
} from "@nestjs/common";
import {
  ApplicationConfig,
  DiscoveryService,
  MetadataScanner,
  ModuleRef,
  ModulesContainer,
  Reflector,
} from "@nestjs/core";
import type {
  AdvisedHandler,
  ApplicationRouteDescriptor,
  AuthorizationPolicy,
  AuthTransport,
  BootAdviceContext,
  ClaimOptions,
  GuardReach,
  Requirement,
  RequirementExpr,
  RoutePlan,
} from "./auth-contracts.js";
import { BetterAuthConfigurationError } from "./auth-errors.js";
import { BetterAuthGuard } from "./auth-guard.js";
import { BetterAuthScopeInterceptor } from "./auth-scope-interceptor.js";
import {
  ACCEPT_PRINCIPALS_METADATA,
  ACCESS_METADATA,
  AUTH_ENHANCER,
  AUTH_INSTANCE_METADATA,
  FORWARD_COOKIES_METADATA,
  FRESHNESS_METADATA,
  INSTANCE_REGISTRY,
  INVOCATION_PARAMS_METADATA,
  MOUNT_COORDINATOR,
  POLICY_RESOLVER,
  PRINCIPAL_PARAMS_METADATA,
  REQUIREMENTS_METADATA,
  ROUTE_PLANNER,
  SKIP_ORIGIN_CHECK_METADATA,
  SKIP_DEFAULT_REQUIREMENTS_METADATA,
  TRANSPORT_REGISTRY,
  USE_BETTER_AUTH_METADATA,
} from "./auth-tokens.js";
import {
  configurationIssue,
  isSingletonDependencyTree,
  type InstanceEntry,
  type InstanceRegistry,
} from "./instance-registry.js";
import type { MountCoordinator } from "./mount-coordinator.js";
import type { PolicyResolver } from "./policy-resolver.js";
import { composeRoutePaths, type RouteVersion } from "./route-paths.js";
import type { RoutePlanner } from "./route-planner.js";
import type { TransportRegistry } from "./transport-registry.js";

type MetadataTarget = Parameters<
  NonNullable<AuthTransport["defaultAccessFor"]>
>[0];

interface Site {
  target: Type;
  method: string;
  handler: (...args: never[]) => unknown;
}
interface PlannedSite extends Site {
  plan: RoutePlan;
}
interface HandlerClaim {
  transport: AuthTransport;
  target: MetadataTarget;
  method: string | undefined;
  reach: GuardReach;
  options: ClaimOptions;
}
export function requirementLeaves(
  expressions: readonly RequirementExpr[],
): Requirement[] {
  return expressions.flatMap((expression) =>
    "anyOf" in expression
      ? requirementLeaves(expression.anyOf)
      : "allOf" in expression
        ? requirementLeaves(expression.allOf)
        : [expression],
  );
}
export function productionMode(): boolean {
  return !["development", "dev", "test"].includes(process.env.NODE_ENV ?? "");
}
function ancestors(target: MetadataTarget): MetadataTarget[] {
  const result: MetadataTarget[] = [];
  for (
    let current: unknown = target;
    typeof current === "function" && current !== Function.prototype;
    current = Object.getPrototypeOf(current)
  ) {
    result.push(current);
  }
  return result;
}
function domainsOverlap(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) {
    return true;
  }
  const left = a.replace(/^\./, "").toLowerCase();
  const right = b.replace(/^\./, "").toLowerCase();
  return (
    left === right || left.endsWith(`.${right}`) || right.endsWith(`.${left}`)
  );
}
function pathsOverlap(a = "/", b = "/"): boolean {
  return (
    a === b ||
    a.startsWith(b.endsWith("/") ? b : `${b}/`) ||
    b.startsWith(a.endsWith("/") ? a : `${a}/`)
  );
}

function routeMayWarnAboutMount(path: string, basePath: string): boolean {
  const route = path.toLowerCase().replace(/(?<!\/)\/+$/, "") || "/";
  const base = basePath.toLowerCase().replace(/(?<!\/)\/+$/, "") || "/";
  if (base === "/") {
    return route.startsWith("/");
  }
  if (route === base || route.startsWith(`${base}/`)) {
    return true;
  }
  const marker = route.search(/[:*{]/);
  if (marker === -1) {
    return false;
  }
  const literal = route.slice(0, marker);
  return base.startsWith(literal) || literal.startsWith(`${base}/`);
}

export class BootValidator {
  readonly logger = new Logger("BetterAuth");
  readonly #plans: PlannedSite[] = [];
  readonly #claims: HandlerClaim[] = [];
  #globalGuard = false;
  #globalScope = false;

  constructor(
    @Inject(DiscoveryService) private readonly discovery: DiscoveryService,
    @Inject(MetadataScanner) private readonly scanner: MetadataScanner,
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(ModuleRef) private readonly moduleRef: ModuleRef,
    @Inject(ApplicationConfig) private readonly appConfig: ApplicationConfig,
    @Inject(INSTANCE_REGISTRY) private readonly instances: InstanceRegistry,
    @Inject(ROUTE_PLANNER) private readonly planner: RoutePlanner,
    @Inject(POLICY_RESOLVER) private readonly policies: PolicyResolver,
    @Inject(TRANSPORT_REGISTRY) private readonly transports: TransportRegistry,
    @Inject(MOUNT_COORDINATOR) private readonly mounts: MountCoordinator,
  ) {}

  private warn(code: string, message: string): void {
    this.logger.warn(`${code}: ${message}`);
  }

  private sites(): Site[] {
    const sites: Site[] = [];
    const seen = new Map<Type, Set<string>>();
    for (const wrapper of [
      ...this.discovery.getControllers(),
      ...this.discovery.getProviders(),
    ]) {
      if (
        wrapper.isAlias ||
        !wrapper.instance ||
        (typeof wrapper.instance !== "object" &&
          typeof wrapper.instance !== "function")
      ) {
        continue;
      }
      const prototype = Object.getPrototypeOf(wrapper.instance) as
        | object
        | null;
      const target = prototype?.constructor as Type | undefined;
      if (!prototype || !target || target === Object || target === Function) {
        continue;
      }
      const methods = seen.get(target) ?? new Set<string>();
      seen.set(target, methods);
      for (const method of this.scanner.getAllMethodNames(prototype)) {
        if (methods.has(method)) {
          continue;
        }
        methods.add(method);
        const handler = Reflect.get(prototype, method);
        if (typeof handler === "function") {
          sites.push({ target, method, handler });
        }
      }
    }
    return sites;
  }

  private singletonChecks(
    issues: BetterAuthConfigurationError[],
    references: readonly Requirement[],
  ): void {
    const refs = new Set(references.map((value) => value.policy));
    for (const wrapper of this.discovery.getProviders()) {
      const key =
        typeof wrapper.token === "symbol"
          ? Symbol.keyFor(wrapper.token)
          : undefined;
      if (
        (key?.startsWith("nestjs-slightly-better-auth:ext:") ||
          refs.has(wrapper.token) ||
          refs.has(wrapper.metatype as Type)) &&
        !isSingletonDependencyTree(wrapper)
      ) {
        issues.push(
          new BetterAuthConfigurationError(
            "NON_SINGLETON_EXTENSION",
            `Extension/policy '${String(wrapper.name)}' has a non-static dependency tree.`,
            "Use singleton extensions and singleton dependencies.",
          ),
        );
      }
    }
  }

  private canaries(): void {
    @Controller("coverage-probe")
    class Probe {
      @Get("handler") run() {}
    }
    if (
      Reflect.getOwnMetadata("path", Probe) !== "coverage-probe" ||
      Reflect.getOwnMetadata("path", Probe.prototype.run) !== "handler" ||
      Reflect.getOwnMetadata("method", Probe.prototype.run) !== 0
    ) {
      throw new BetterAuthConfigurationError(
        "NEST_METADATA_KEY_CHANGED",
        "Boot route checks cannot read Nest path/method metadata.",
      );
    }
    UseGuards(BetterAuthGuard)(Probe);
    UseInterceptors(BetterAuthScopeInterceptor)(Probe);
    if (
      !(
        Reflect.getOwnMetadata("__guards__", Probe) as unknown[] | undefined
      )?.includes(BetterAuthGuard) ||
      !(
        Reflect.getOwnMetadata("__interceptors__", Probe) as
          | unknown[]
          | undefined
      )?.includes(BetterAuthScopeInterceptor)
    ) {
      throw new BetterAuthConfigurationError(
        "NEST_METADATA_KEY_CHANGED",
        "Boot coverage cannot read Nest '__guards__' / '__interceptors__' metadata.",
        "Use a compatible Nest version and report the metadata change.",
      );
    }
  }

  private enhancer(value: unknown, kind: "guard" | "scope"): boolean {
    const token =
      kind === "guard" ? BetterAuthGuard : BetterAuthScopeInterceptor;
    let actual: unknown;
    try {
      actual = this.moduleRef.get(token, { strict: false });
    } catch {
      actual = undefined;
    }
    if (value === token || (actual !== undefined && value === actual)) {
      return true;
    }
    if (value && (typeof value === "object" || typeof value === "function")) {
      const brand =
        Reflect.get(value, AUTH_ENHANCER) ??
        (typeof value === "function"
          ? Reflect.get(value.prototype ?? {}, AUTH_ENHANCER)
          : Reflect.get(Object.getPrototypeOf(value) ?? {}, AUTH_ENHANCER));
      return (
        brand === kind ||
        (kind === "scope" && brand === "interceptor") ||
        (typeof brand === "object" &&
          brand !== null &&
          Reflect.get(brand, kind) === true)
      );
    }
    return false;
  }

  private local(
    site: { target: MetadataTarget; method?: string },
    kind: "guard" | "scope",
  ): boolean {
    const handler = site.method
      ? (Reflect.get(site.target.prototype ?? {}, site.method) as
          | object
          | undefined)
      : undefined;
    const targets: object[] = [
      ...ancestors(site.target),
      ...(handler ? [handler] : []),
    ];
    if (
      targets.some(
        (target) =>
          Reflect.getOwnMetadata(USE_BETTER_AUTH_METADATA, target) === true,
      )
    ) {
      return true;
    }
    const key = kind === "guard" ? "__guards__" : "__interceptors__";
    return targets.some((target) =>
      ((Reflect.getOwnMetadata(key, target) ?? []) as unknown[]).some((value) =>
        this.enhancer(value, kind),
      ),
    );
  }

  private trigger(target: object): boolean {
    const access = Reflect.getOwnMetadata(ACCESS_METADATA, target) as unknown;
    if (
      access === "required" ||
      access === "optional" ||
      access === "authenticated"
    ) {
      return true;
    }
    return [
      ACCEPT_PRINCIPALS_METADATA,
      REQUIREMENTS_METADATA,
      PRINCIPAL_PARAMS_METADATA,
      INVOCATION_PARAMS_METADATA,
      FORWARD_COOKIES_METADATA,
      FRESHNESS_METADATA,
      AUTH_INSTANCE_METADATA,
      USE_BETTER_AUTH_METADATA,
    ].some((key) => Reflect.hasOwnMetadata(key, target));
  }

  private coverage(
    sites: readonly Site[],
    issues: BetterAuthConfigurationError[],
  ): void {
    this.#globalGuard = [
      ...this.appConfig.getGlobalGuards(),
      ...this.appConfig
        .getGlobalRequestGuards()
        .map((wrapper) => wrapper.instance),
    ].some((value) => this.enhancer(value, "guard"));
    this.#globalScope = [
      ...this.appConfig.getGlobalInterceptors(),
      ...this.appConfig
        .getGlobalRequestInterceptors()
        .map((wrapper) => wrapper.instance),
    ].some((value) => this.enhancer(value, "scope"));
    for (const claim of this.#claims) {
      let plan: RoutePlan | undefined;
      try {
        plan = claim.method
          ? this.planner.plan(claim.target as Type, claim.method)
          : undefined;
      } catch {
        continue;
      }
      const classEntry = this.instances
        .list()
        .find(
          (entry) =>
            entry.name ===
            (Reflect.getMetadata(AUTH_INSTANCE_METADATA, claim.target) ??
              "default"),
        );
      const classForwarding =
        Reflect.getMetadata(FORWARD_COOKIES_METADATA, claim.target) ??
        classEntry?.options.cookies?.forwardDirectCalls ??
        false;
      const classForm =
        classForwarding &&
        Reflect.getMetadata(SKIP_ORIGIN_CHECK_METADATA, claim.target) !==
          true &&
        classEntry?.options.originCheck?.mode !== "off";
      const accessCovered = plan
        ? (plan.access === "public" || plan.access === "inherit") &&
          plan.originCheck !== "form"
        : Reflect.getMetadata(ACCESS_METADATA, claim.target) === "public" &&
          !classForm;
      const localGuard = this.local(claim, "guard");
      const localScope = this.local(claim, "scope");
      const covered =
        accessCovered ||
        (claim.reach === "global" && (this.#globalGuard || localGuard)) ||
        (claim.reach === "explicit" && localGuard && localScope);
      const declares =
        plan?.declares ??
        ancestors(claim.target).some((target) => this.trigger(target));
      if (
        !covered &&
        (claim.options.everyHandler || declares) &&
        claim.options.coverage !== "off"
      ) {
        const message = `${claim.target.name}${claim.method ? `.${claim.method}` : ""} is not covered by the required auth enhancers.`;
        if (claim.options.coverage === "warn") {
          this.warn(claim.options.code, `${message} ${claim.options.hint}`);
        } else {
          issues.push(
            new BetterAuthConfigurationError(
              claim.options.code,
              message,
              claim.options.hint,
            ),
          );
        }
      }
    }
    for (const site of sites) {
      const classClaims = this.#claims.filter(
        (claim) => claim.target === site.target,
      );
      if (
        classClaims.some(
          (claim) => claim.method === undefined || claim.method === site.method,
        )
      ) {
        continue;
      }
      if (
        this.trigger(site.handler) ||
        (!classClaims.length &&
          ancestors(site.target).some((target) => this.trigger(target)))
      ) {
        issues.push(
          new BetterAuthConfigurationError(
            "UNGUARDED_AUTH_METADATA",
            `${site.target.name}.${site.method} declares auth metadata but no transport claims it. Registered transports: ${this.transports
              .list()
              .map((value) => value.id)
              .join(", ")}.`,
            "Register a transport that claims this handler.",
          ),
        );
      }
    }
    if (!this.#globalScope) {
      const affected = this.#claims.flatMap((claim) => {
        if (this.local(claim, "scope")) {
          return [];
        }
        const plan = this.#plans.find(
          (site) =>
            site.target === claim.target && site.method === claim.method,
        )?.plan;
        if (plan) {
          return plan.declares
            ? [{ claim, forwarding: plan.forwardDirectCalls }]
            : [];
        }
        if (claim.method !== undefined) {
          return [];
        }
        const entry = this.instances
          .list()
          .find(
            (value) =>
              value.name ===
              (Reflect.getMetadata(AUTH_INSTANCE_METADATA, claim.target) ??
                "default"),
          );
        const forwarding =
          Reflect.getMetadata(FORWARD_COOKIES_METADATA, claim.target) ??
          entry?.options.cookies?.forwardDirectCalls ??
          false;
        return forwarding ||
          ancestors(claim.target).some((target) => this.trigger(target))
          ? [{ claim, forwarding: Boolean(forwarding) }]
          : [];
      });
      const seen = new Map<MetadataTarget, Set<string | undefined>>();
      const uncovered = affected
        .sort(
          (left, right) => Number(right.forwarding) - Number(left.forwarding),
        )
        .filter(({ claim }) => {
          const methods =
            seen.get(claim.target) ?? new Set<string | undefined>();
          seen.set(claim.target, methods);
          if (methods.has(claim.method)) {
            return false;
          }
          methods.add(claim.method);
          return true;
        })
        .slice(0, 20)
        .map(({ claim }) => `${claim.target.name}.${claim.method ?? "*"}`);
      this.warn(
        "W_NO_GLOBAL_SCOPE",
        `BetterAuthScopeInterceptor is not global; unscoped direct auth.api calls have no origin proof, refresh suppression or cookie bridge. Enable globalScope or apply @UseBetterAuth(). ${uncovered.join(", ")}`,
      );
    }
  }

  private entryChecks(
    entry: InstanceEntry,
    policies: readonly AuthorizationPolicy[],
    issues: BetterAuthConfigurationError[],
  ): void {
    const { name, context, options, sources, bridge } = entry;
    for (const unit of [...sources, ...policies]) {
      for (const plugin of unit.requires?.plugins ?? []) {
        if (!context.hasPlugin(plugin)) {
          issues.push(
            new BetterAuthConfigurationError(
              "PLUGIN_PREREQUISITE",
              `'${name}': '${unit.id}' requires the '${plugin}' plugin.`,
              `Add the '${plugin}' Better Auth plugin.`,
            ),
          );
        }
      }
    }
    const base = context.options.baseURL;
    const dynamic =
      !!base && typeof base === "object" && "allowedHosts" in base;
    if (dynamic && !("fallback" in base && base.fallback)) {
      const hostless = [
        ...sources,
        ...policies,
        ...this.transports.list(),
      ].filter((unit) => unit.requires?.hostlessCalls);
      if (hostless.length) {
        issues.push(
          new BetterAuthConfigurationError(
            "DYNAMIC_BASE_URL_WITHOUT_FALLBACK",
            `'${name}': ${hostless.map((unit) => unit.id).join(", ")} make hostless calls.`,
            "Add baseURL.fallback to the dynamic allowedHosts configuration.",
          ),
        );
      } else {
        this.warn(
          "W_DYNAMIC_HOST",
          `'${name}': dynamic baseURL has no fallback; rejected hosts may make auth.handler throw.`,
        );
      }
    }
    const production = productionMode();
    if (production && !context.baseURL && !dynamic) {
      if (options.http?.allowRequestDerivedBaseURL) {
        this.warn(
          "W_REQUEST_DERIVED_BASE_URL",
          `'${name}': requests choose the origin of token links and trusted origins.`,
        );
      } else {
        issues.push(
          new BetterAuthConfigurationError(
            "UNSAFE_BASE_URL",
            `'${name}' has no safe baseURL in production.`,
            "Set baseURL / BETTER_AUTH_URL, or dynamic baseURL.allowedHosts.",
          ),
        );
      }
    }
    if (
      production &&
      context.secret === "better-auth-secret-12345678901234567890"
    ) {
      issues.push(
        new BetterAuthConfigurationError(
          "DEFAULT_SECRET",
          `'${name}' uses Better Auth's public default signing secret.`,
          "Set BETTER_AUTH_SECRET or betterAuth({ secret }).",
        ),
      );
    }
    if (context.skipCSRFCheck || context.skipOriginCheck === true) {
      const explicit = context.options.advanced;
      const cause = `disableCSRFCheck=${String(explicit?.disableCSRFCheck)}, disableOriginCheck=${String(explicit?.disableOriginCheck)}; unset flags use Better Auth's import-time NODE_ENV/TEST defaults`;
      const exception =
        context.skipOriginCheck === true && explicit?.disableCSRFCheck === false
          ? "; disableCSRFCheck:false does not re-enable SDK origin checks; app-route checks remain on"
          : "";
      this.warn(
        "W_ORIGIN_CHECK",
        `'${name}': resolved skipCSRFCheck=${context.skipCSRFCheck}, skipOriginCheck=${String(context.skipOriginCheck)} (${cause})${exception}.`,
      );
    }
    if (
      Array.isArray(context.skipOriginCheck) &&
      context.skipOriginCheck.length
    ) {
      this.logger.log(
        `I_AUTH_ORIGIN_PATH_SKIPS: '${name}': ${context.skipOriginCheck.join(", ")}; app-route checks are unchanged.`,
      );
    }
    if (production && options.originCheck?.mode === "off") {
      this.warn(
        "W_ORIGIN_CHECK",
        `'${name}': application origin checks are disabled.`,
      );
    }
    if (name === "default" && options.cookies?.forwardDirectCalls) {
      this.warn(
        "W_FORWARD_DIRECT_CALLS",
        "The default instance forwards same-credential direct-call cookies app-wide; every handler requires form-CSRF enforcement.",
      );
    }
    const proxy =
      this.mounts.adapter &&
      this.mounts.platform?.proxyTrust?.(this.mounts.adapter);
    const ip = context.options.advanced?.ipAddress;
    const role = context.rateLimit.enabled
      ? "rate-limit buckets and session IP"
      : "session IP only (rate limiter disabled)";
    if (
      production &&
      bridge.clientIpHeader &&
      ip?.ipAddressHeaders?.[0] !== bridge.clientIpHeader
    ) {
      this.warn(
        "W_CLIENT_IP",
        `'${name}': the bridge IP header is not first in effective ipAddressHeaders (${role}).`,
      );
    }
    if (
      production &&
      !bridge.clientIpHeader &&
      !ip?.ipAddressHeaders?.length &&
      !ip?.trustedProxies?.length
    ) {
      this.warn(
        "W_CLIENT_IP",
        `'${name}': no bridge IP header or SDK IP configuration (${role}).`,
      );
    }
    if (
      production &&
      bridge.clientIpHeader &&
      ip?.trustedProxies?.length &&
      proxy &&
      proxy.mode === "none"
    ) {
      this.warn(
        "W_CLIENT_IP",
        `'${name}': SDK trustedProxies rechecks the socket IP without platform proxy trust (${role}); configure platform trust or set clientIpHeader:false.`,
      );
    }
    if (production && proxy && proxy.mode === "all") {
      this.warn(
        "W_PROXY_TRUST_ALL",
        `'${name}': the platform trusts every proxy; clients can choose ${role}.`,
      );
    }
    if (
      production &&
      !context.rateLimit.enabled &&
      context.options.rateLimit?.enabled === undefined
    ) {
      const contradiction =
        process.env.NODE_ENV === "production"
          ? " while process.env.NODE_ENV is production; Better Auth imported before that value existed"
          : "";
      this.warn(
        "W_RATE_LIMIT_DISABLED",
        `'${name}': better-auth resolved rateLimit.enabled=false${contradiction}. Set NODE_ENV=production before auth.ts is imported, rateLimit.enabled:true, or explicitly disable it when an edge proxy limits traffic.`,
      );
    }
  }

  private cookies(issues: BetterAuthConfigurationError[]): void {
    const entries = this.instances.list();
    for (let i = 0; i < entries.length; i++) {
      for (const right of entries.slice(i + 1)) {
        const left = entries[i]!;
        for (const a of Object.values(left.context.authCookies)) {
          for (const b of Object.values(right.context.authCookies)) {
            if (
              a.name === b.name &&
              domainsOverlap(a.attributes.domain, b.attributes.domain) &&
              pathsOverlap(a.attributes.path, b.attributes.path)
            ) {
              issues.push(
                new BetterAuthConfigurationError(
                  "COOKIE_NAME_COLLISION",
                  `'${left.name}' and '${right.name}' both use cookie '${a.name}' on overlapping scopes.`,
                  "Set advanced.cookiePrefix on one instance.",
                ),
              );
            }
          }
        }
      }
    }
  }

  async validate(issues: BetterAuthConfigurationError[]): Promise<void> {
    this.#plans.length = 0;
    this.#claims.length = 0;
    const sites = this.sites();
    const candidates = new Map<MetadataTarget, Map<string, Site>>();
    const prepared = new Set<Site>();
    const compiled = new Map<Site, RoutePlan>();
    const failures = new Map<Site, unknown>();
    const reported = new Set<unknown>();
    const references: Requirement[] = [];
    const report = (error: unknown, detail: string): void => {
      if (!reported.has(error)) {
        reported.add(error);
        issues.push(configurationIssue(error, "UNRESOLVED_POLICY", detail));
      }
    };
    const candidate = (target: MetadataTarget, method: string): Site => {
      let methods = candidates.get(target);
      if (!methods) {
        methods = new Map();
        candidates.set(target, methods);
      }
      const existing = methods.get(method);
      if (existing) {
        return existing;
      }
      const handler = Reflect.get(target.prototype ?? {}, method);
      if (typeof handler !== "function") {
        throw new BetterAuthConfigurationError(
          "UNKNOWN_HANDLER",
          `${target.name}.${method} is not a handler.`,
        );
      }
      const site = { target: target as Type, method, handler };
      methods.set(method, site);
      return site;
    };
    const prepare = (site: Site): void => {
      if (failures.has(site)) {
        throw failures.get(site);
      }
      if (prepared.has(site)) {
        return;
      }
      try {
        const leaves = requirementLeaves(
          this.planner.requirementsOf(site.target, site.method),
        );
        references.push(...leaves);
        for (const requirement of leaves) {
          this.policies.resolve(requirement.policy);
        }
        prepared.add(site);
      } catch (error) {
        failures.set(site, error);
        throw error;
      }
    };
    const planOf = (target: MetadataTarget, method: string): RoutePlan => {
      const site = candidate(target, method);
      prepare(site);
      const cached = compiled.get(site);
      if (cached) {
        return cached;
      }
      try {
        const plan = this.planner.plan(site.target, site.method);
        compiled.set(site, plan);
        this.#plans.push({ ...site, plan });
        return plan;
      } catch (error) {
        failures.set(site, error);
        throw error;
      }
    };
    // Discovery remains broad for unclaimed metadata. Only explicit method
    // metadata and transport-identified handlers enter the planning population.
    for (const site of sites) {
      if (
        this.trigger(site.handler) ||
        [
          ACCESS_METADATA,
          FRESHNESS_METADATA,
          SKIP_ORIGIN_CHECK_METADATA,
          SKIP_DEFAULT_REQUIREMENTS_METADATA,
        ].some((key) => Reflect.hasOwnMetadata(key, site.handler))
      ) {
        const selected = candidate(site.target, site.method);
        try {
          prepare(selected);
        } catch (error) {
          report(error, `Cannot prepare ${site.target.name}.${site.method}.`);
        }
      }
    }
    let canariesPassed = false;
    try {
      this.canaries();
      canariesPassed = true;
    } catch (error) {
      issues.push(
        configurationIssue(
          error,
          "NEST_METADATA_KEY_CHANGED",
          "Coverage metadata canaries failed.",
        ),
      );
    }
    if (canariesPassed) {
      for (const transport of this.transports.list()) {
        try {
          await transport.validate?.({
            discovery: this.discovery,
            reflector: this.reflector,
            moduleRef: this.moduleRef,
            hasHttpAdapter: this.mounts.adapter !== null,
            // A transport may need the plan before claiming its handler. The
            // same pre-resolution pass applies to that synchronous request.
            planOf,
            claim: (target, method, reach, options) => {
              this.#claims.push({ transport, target, method, reach, options });
              if (method !== undefined) {
                candidate(target, method);
              }
            },
            logger: this.logger,
          });
        } catch (error) {
          if (!reported.has(error)) {
            reported.add(error);
            issues.push(
              configurationIssue(
                error,
                "TRANSPORT_VALIDATION_FAILED",
                `Transport '${transport.id}' failed validation.`,
              ),
            );
          }
        }
      }
    }
    for (const methods of candidates.values()) {
      for (const site of methods.values()) {
        try {
          prepare(site);
        } catch (error) {
          report(error, `Cannot prepare ${site.target.name}.${site.method}.`);
        }
      }
    }
    this.singletonChecks(issues, references);
    for (const methods of candidates.values()) {
      for (const site of methods.values()) {
        try {
          planOf(site.target, site.method);
        } catch (error) {
          report(error, `Cannot compile ${site.target.name}.${site.method}.`);
        }
      }
    }
    for (const site of this.#plans) {
      try {
        const entry = this.instances.get(site.plan.instance);
        for (const requirement of requirementLeaves(site.plan.requirements)) {
          await this.policies
            .resolve(requirement.policy)
            .validate?.(requirement.params, {
              auth: entry.handle,
              context: entry.context,
              site: site.plan.site,
            });
        }
      } catch (error) {
        report(error, `Cannot validate ${site.target.name}.${site.method}.`);
      }
    }
    if (canariesPassed) {
      this.coverage(sites, issues);
      const applicationRoutes: ApplicationRouteDescriptor[] = [];
      const globalPrefix = this.appConfig.getGlobalPrefix();
      const globalPrefixExclusions =
        this.appConfig.getGlobalPrefixOptions().exclude;
      const versioningOptions = this.appConfig.getVersioning();
      const modules = this.moduleRef.get(ModulesContainer, { strict: false });
      for (const wrapper of this.discovery.getControllers()) {
        const target = wrapper.metatype;
        if (!target?.prototype) {
          continue;
        }
        const moduleType = wrapper.host?.metatype;
        const modulePath = moduleType
          ? (Reflect.getMetadata(
              `__module_path__${modules.applicationId}`,
              moduleType,
            ) ?? Reflect.getMetadata("__module_path__", moduleType))
          : undefined;
        const host = Reflect.getMetadata("host", target) as unknown;
        const controllerVersion = versioningOptions
          ? (Reflect.getMetadata("__version__", target) ??
            versioningOptions.defaultVersion)
          : undefined;
        const rawPrefixes = Reflect.getMetadata("path", target) as
          | string
          | string[]
          | undefined;
        const prefixes = Array.isArray(rawPrefixes)
          ? rawPrefixes
          : [rawPrefixes ?? ""];
        for (const method of this.scanner.getAllMethodNames(target.prototype)) {
          const handler = Reflect.get(target.prototype, method);
          const rawPaths = Reflect.getMetadata("path", handler) as
            | string
            | string[]
            | undefined;
          const requestMethod = Reflect.getMetadata("method", handler) as
            | RequestMethod
            | undefined;
          if (rawPaths === undefined || requestMethod === undefined) {
            continue;
          }
          const methodVersion = Reflect.getMetadata("__version__", handler) as
            | RouteVersion
            | undefined;
          const effectiveVersion = methodVersion ?? controllerVersion;
          const conditions: ("host" | "version")[] = [];
          if (host !== undefined) {
            conditions.push("host");
          }
          if (
            versioningOptions &&
            versioningOptions.type !== VersioningType.URI &&
            effectiveVersion !== undefined &&
            effectiveVersion !== VERSION_NEUTRAL
          ) {
            conditions.push("version");
          }
          for (const prefix of prefixes) {
            for (const path of Array.isArray(rawPaths)
              ? rawPaths
              : [rawPaths]) {
              const resolvedPaths = composeRoutePaths(
                {
                  ctrlPath: prefix,
                  methodPath: path,
                  modulePath,
                  globalPrefix,
                  controllerVersion: controllerVersion as RouteVersion,
                  methodVersion,
                  versioningOptions,
                },
                requestMethod,
                globalPrefixExclusions,
              ).map((route) => this.mounts.normalizeApplicationRoute(route));
              const source = `${target.name}.${method}`;
              applicationRoutes.push(
                Object.freeze({
                  method: RequestMethod[requestMethod] ?? String(requestMethod),
                  paths: Object.freeze([...resolvedPaths]),
                  conditions: Object.freeze([...conditions]),
                  source,
                }),
              );
              for (const route of resolvedPaths) {
                const binding = this.mounts
                  .bindings()
                  .find((candidate) =>
                    routeMayWarnAboutMount(route, candidate.basePath),
                  );
                if (!binding) {
                  continue;
                }
                this.warn(
                  "W_ROUTE_SHADOWS_AUTH",
                  `${source} at '${route}' may shadow auth mount '${binding.basePath}'.`,
                );
              }
            }
          }
        }
      }
      this.mounts.registerApplicationRoutes(
        Object.freeze(applicationRoutes),
        issues,
      );
    }
    this.cookies(issues);
    for (const entry of this.instances.list()) {
      const plans = this.#plans.filter(
        (site) => site.plan.instance === entry.name,
      );
      const policies = [
        ...new Set(
          plans.flatMap((site) =>
            requirementLeaves(site.plan.requirements).map((requirement) =>
              this.policies.resolve(requirement.policy),
            ),
          ),
        ),
      ];
      this.entryChecks(entry, policies, issues);
      const handlers: AdvisedHandler[] = plans.map((site) => {
        const claims = this.#claims.filter(
          (claim) =>
            claim.target === site.target &&
            (claim.method === undefined || claim.method === site.method),
        );
        return {
          plan: site.plan,
          transports: [...new Set(claims.map((claim) => claim.transport.id))],
          inputs: [
            ...new Set(claims.flatMap((claim) => claim.options.inputs ?? [])),
          ],
        };
      });
      const advice: BootAdviceContext = {
        instance: entry.name,
        auth: entry.handle,
        context: entry.context,
        production: productionMode(),
        hasHttpAdapter: this.mounts.adapter !== null,
        originCheck: {
          mode: entry.options.originCheck?.mode ?? "cookie",
          missingOrigin: entry.options.originCheck?.missingOrigin ?? "reject",
        },
        handlers,
        transports: this.transports
          .list()
          .map((transport) => ({ id: transport.id })),
        sources: entry.sources,
        policies,
      };
      for (const unit of [
        ...entry.sources,
        ...policies,
        ...this.transports.list(),
        ...(this.mounts.platform ? [this.mounts.platform] : []),
      ]) {
        try {
          for (const item of (await unit.advise?.(advice)) ?? []) {
            const line = `${item.code}: '${entry.name}' ${unit.id}: ${item.message}${item.hint ? ` ${item.hint}` : ""}`;
            if (item.level === "warn") {
              this.logger.warn(line);
            } else {
              this.logger.log(line);
            }
          }
        } catch (error) {
          issues.push(
            configurationIssue(
              error,
              "EXTENSION_ADVICE_FAILED",
              `Advice from '${unit.id}' failed.`,
            ),
          );
        }
      }
    }
  }

  summary(
    hooks: ReadonlyMap<string, import("./hook-binder.js").HookTables>,
  ): void {
    for (const entry of this.instances.list()) {
      if (entry.options.logSummary === false) {
        continue;
      }
      const mount = this.mounts.binding(entry.name);
      const plans = this.#plans
        .filter((site) => site.plan.instance === entry.name)
        .map((site) => site.plan);
      const rate = entry.context.rateLimit.enabled
        ? "on"
        : entry.context.options.rateLimit?.enabled === false
          ? "off (rateLimit.enabled:false)"
          : process.env.NODE_ENV === "production"
            ? "off (Better Auth saw no NODE_ENV=production at import time; see W_RATE_LIMIT_DISABLED)"
            : `off (NODE_ENV ${process.env.NODE_ENV ?? "unset"}; Better Auth enables it for NODE_ENV=production)`;
      const table = hooks.get(entry.name);
      const hookSummary = table
        ? `${table.before.length} before, ${table.after.length} after, ${Object.values(table.database).reduce((count, value) => count + value.before.length + value.after.length, 0)} database`
        : "none";
      const proxy = this.mounts.adapter
        ? this.mounts.platform?.proxyTrust?.(this.mounts.adapter)
        : undefined;
      const defaults = `access: ${entry.options.defaultAccess ?? "authenticated"}; origin: ${entry.options.originCheck?.mode ?? "cookie"}/${entry.options.originCheck?.missingOrigin ?? "reject"}; direct-call cookies: ${entry.options.cookies?.forwardDirectCalls ? "same-credential" : "opt-in"}`;
      const guardOrder = this.appConfig
        .getGlobalGuards()
        .map((guard) => guard.constructor.name)
        .join(" → ");
      this.logger.log(
        `'${entry.name}': ${mount ? `mounted at ${mount.basePath} (${mount.bodyLimit} bytes)` : "not mounted"}; platform: ${this.mounts.platform?.id ?? "none"} (trust proxy: ${proxy?.mode ?? "unknown"}${proxy?.detail ? ` ${proxy.detail}` : ""}); outside global prefix '${this.appConfig.getGlobalPrefix()}'; hooks: ${hookSummary}; defaults: ${defaults}; transports: ${this.transports
          .list()
          .map((unit) => unit.id)
          .join(
            ", ",
          )}; principals: ${entry.sources.map((unit) => `${unit.id} (${unit.acceptance ?? "explicit"})`).join(" → ")}; handlers: ${plans.length} (${plans.filter((plan) => plan.access === "public").length} public, ${plans.filter((plan) => plan.access === "optional").length} optional, ${plans.filter((plan) => plan.access === "inherit").length} inherit, ${plans.filter((plan) => plan.skipsDefaultRequirements).length} skip defaults); environment: ${productionMode() ? "production" : "development"} (NODE_ENV ${process.env.NODE_ENV ?? "unset"}); rate limit: ${rate}; scope: ${this.#globalScope ? "global" : "off — see W_NO_GLOBAL_SCOPE"}; global guards: ${guardOrder}`,
      );
    }
  }
}
