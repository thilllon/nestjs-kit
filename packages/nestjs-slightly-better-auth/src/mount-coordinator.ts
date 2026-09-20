import { Inject, Logger } from "@nestjs/common";
import { HttpAdapterHost, type AbstractHttpAdapter } from "@nestjs/core";
import type { AuthRouteBinding, HttpPlatform } from "./auth-contracts.js";
import { BetterAuthConfigurationError } from "./auth-errors.js";
import { AuthExchange } from "./auth-exchange.js";
import { INSTANCE_REGISTRY, REQUEST_SCOPE } from "./auth-tokens.js";
import {
  configurationIssue,
  type InstanceRegistry,
} from "./instance-registry.js";
import type { RequestScope } from "./request-scope.js";

const MOUNTED = Symbol.for("nestjs-slightly-better-auth:mounted");
export function parseBodyLimit(input: number | string | undefined): number {
  if (input === undefined) {
    return 1_048_576;
  }
  const match =
    typeof input === "string"
      ? /^(\d+(?:\.\d+)?)(b|kb|mb)$/i.exec(input)
      : null;
  const value =
    typeof input === "number"
      ? input
      : match
        ? Number(match[1]) *
          ({ b: 1, kb: 1024, mb: 1048576 }[match[2]!.toLowerCase()] ?? 0)
        : Number.NaN;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BetterAuthConfigurationError(
      "INVALID_BODY_LIMIT",
      `Invalid auth body limit '${input}'.`,
      "Use a nonnegative byte count or a value such as '1mb'.",
    );
  }
  return value;
}

export class MountCoordinator {
  readonly logger = new Logger("BetterAuth");
  readonly #exchange: AuthExchange;
  readonly #bindings = new Map<string, AuthRouteBinding>();
  #platforms: readonly HttpPlatform[] | undefined;
  #prepared: AbstractHttpAdapter | null = null;
  #selected: HttpPlatform | undefined;
  #preparationErrors: BetterAuthConfigurationError[] = [];

  constructor(
    @Inject(HttpAdapterHost) readonly host: HttpAdapterHost,
    @Inject(INSTANCE_REGISTRY) private readonly registry: InstanceRegistry,
    @Inject(REQUEST_SCOPE) scope: RequestScope,
  ) {
    this.#exchange = new AuthExchange(scope);
    host.init$.subscribe(() => this.tryPrepare(false));
  }

  registerPlatforms(platforms: readonly HttpPlatform[]): void {
    this.#platforms = platforms;
    this.tryPrepare(false);
  }

  get platform(): HttpPlatform | undefined {
    return this.#selected;
  }

  get adapter(): AbstractHttpAdapter | null {
    return this.host.httpAdapter ?? null;
  }

  private tryPrepare(atInit: boolean): void {
    const adapter = this.adapter;
    if (!adapter || !this.#platforms || this.#prepared === adapter) {
      return;
    }
    try {
      if (this.registry.state !== "new" && this.registry.adapter !== adapter) {
        throw new BetterAuthConfigurationError(
          "LATE_HTTP_ADAPTER",
          "The HTTP adapter changed while the application is active.",
          "Close the first application before starting another.",
        );
      }
      const supported = this.#platforms.filter((platform) =>
        platform.supports(adapter),
      );
      if (supported.length !== 1) {
        throw new BetterAuthConfigurationError(
          supported.length ? "AMBIGUOUS_PLATFORM" : "NO_PLATFORM",
          `Expected exactly one supporting HTTP platform; found ${supported.length}.`,
          "Register the platform for your HTTP adapter on the default instance.",
        );
      }
      const platform = supported[0]!;
      if (
        atInit &&
        this.#prepared !== null &&
        !platform.capabilities?.prepareAtInit
      ) {
        throw new BetterAuthConfigurationError(
          "APP_ADAPTER_CHANGED",
          "The application uses a different HTTP adapter after preparation.",
          "Compile a new TestingModule for each application (or use NestFactory).",
        );
      }
      platform.prepare?.({
        adapter,
        logger: this.logger,
        route: (pathname) => this.route(pathname),
      });
      this.#selected = platform;
      this.#prepared = adapter;
    } catch (error) {
      this.#preparationErrors.push(
        configurationIssue(
          error,
          "PLATFORM_PREPARATION_FAILED",
          "HTTP platform preparation failed.",
        ),
      );
    }
  }

  prepareAtInit(issues: BetterAuthConfigurationError[]): void {
    this.tryPrepare(true);
    issues.push(...this.#preparationErrors);
    this.#preparationErrors = [];
    if (this.adapter && this.#selected) {
      try {
        this.#selected.validate?.(this.adapter);
      } catch (error) {
        issues.push(
          configurationIssue(
            error,
            "PLATFORM_VALIDATION_FAILED",
            "HTTP platform validation failed.",
          ),
        );
      }
    }
  }

  resolve(issues: BetterAuthConfigurationError[]): void {
    this.#bindings.clear();
    const adapter = this.adapter;
    if (!adapter || !this.#selected) {
      return;
    }
    const server = adapter.getInstance() as object;
    const mounted = Reflect.get(server, MOUNTED) as Set<string> | undefined;
    for (const entry of this.registry.list()) {
      if (entry.options.http?.mount === false) {
        continue;
      }
      try {
        const raw = entry.context.baseURL
          ? new URL(entry.context.baseURL).pathname
          : entry.context.options.basePath || "/api/auth";
        const basePath = raw.length > 1 ? raw.replace(/\/+$/, "") : raw;
        if (
          !basePath.startsWith("/") ||
          (basePath === "/" && !entry.options.http?.allowRootMount)
        ) {
          throw new BetterAuthConfigurationError(
            "INVALID_MOUNT_PATH",
            `Invalid auth mount path '${basePath}'.`,
            "Use an absolute path; opt into root mounting with http.allowRootMount.",
          );
        }
        if (mounted?.has(basePath)) {
          throw new BetterAuthConfigurationError(
            "DUPLICATE_MOUNT",
            `Auth path '${basePath}' is already mounted on this server.`,
            "Create a fresh application and adapter.",
          );
        }
        for (const existing of this.#bindings.values()) {
          if (
            basePath === "/" ||
            existing.basePath === "/" ||
            existing.matches(basePath) ||
            basePath.startsWith(`${existing.basePath}/`) ||
            existing.basePath.startsWith(`${basePath}/`)
          ) {
            throw new BetterAuthConfigurationError(
              "OVERLAPPING_MOUNTS",
              `Mounts '${existing.basePath}' and '${basePath}' overlap.`,
              "Use separate basePath values for named instances.",
            );
          }
        }
        this.#bindings.set(
          entry.name,
          this.#exchange.create(entry, {
            basePath,
            bodyLimit: parseBodyLimit(entry.options.http?.bodyLimit),
            staticOrigin: entry.context.baseURL
              ? new URL(entry.context.baseURL).origin
              : undefined,
            logger: this.logger,
            proxyTrust: this.#selected.proxyTrust?.(adapter),
          }),
        );
      } catch (error) {
        issues.push(
          configurationIssue(
            error,
            "INVALID_MOUNT_PATH",
            `Cannot resolve mount for '${entry.name}'.`,
          ),
        );
      }
    }
  }

  route(pathname: string): AuthRouteBinding | undefined {
    return [...this.#bindings.values()].find((binding) =>
      binding.matches(pathname),
    );
  }

  binding(name: string): AuthRouteBinding | undefined {
    return this.#bindings.get(name);
  }

  async mount(): Promise<void> {
    const adapter = this.adapter;
    const platform = this.#selected;
    if (!adapter || !platform) {
      return;
    }
    const server = adapter.getInstance() as object;
    let mounted = Reflect.get(server, MOUNTED) as Set<string> | undefined;
    if (!mounted) {
      mounted = new Set();
      Object.defineProperty(server, MOUNTED, { value: mounted });
    }
    for (const binding of this.#bindings.values()) {
      if (mounted.has(binding.basePath)) {
        throw new BetterAuthConfigurationError(
          "DUPLICATE_MOUNT",
          `Auth path '${binding.basePath}' is already mounted.`,
        );
      }
      await platform.mount({ adapter, logger: this.logger, binding });
      mounted.add(binding.basePath);
    }
  }

  reset(): void {
    this.#bindings.clear();
    this.#preparationErrors = [];
  }
}
