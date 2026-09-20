import { Inject, Logger } from "@nestjs/common";
import type { AbstractHttpAdapter } from "@nestjs/core";
import type { InstanceWrapper } from "@nestjs/core/injector/instance-wrapper.js";
import type {
  AuthContextView,
  AuthHandle,
  BetterAuthAppOptions,
  BetterAuthRuntimeOptions,
  BetterAuthStaticOptions,
  PrincipalSource,
} from "./auth-contracts.js";
import {
  BetterAuthConfigurationError,
  isConfigurationError,
} from "./auth-errors.js";
import { REQUEST_SCOPE } from "./auth-tokens.js";
import type { AuthLike } from "./auth-types.js";
import { createAuthHandle } from "./bridge-client.js";
import { BRIDGE_HANDLE, type BridgeHandle } from "./bridge-protocol.js";
import { OriginCheck, OriginDiagnostics } from "./origin-check.js";
import type { RequestScope } from "./request-scope.js";

/** Nest considers transient providers static; auth collaborators require singleton trees. */
export function isSingletonDependencyTree(root: InstanceWrapper): boolean {
  const pending = [root];
  const seen = new Set<InstanceWrapper>();
  while (pending.length) {
    const wrapper = pending.pop()!;
    if (seen.has(wrapper)) {
      continue;
    }
    seen.add(wrapper);
    if (wrapper.isTransient || !wrapper.isDependencyTreeStatic()) {
      return false;
    }
    // useExisting aliases are constructor-injection edges to their real target.
    for (const dependency of wrapper.getCtorMetadata() ?? []) {
      if (dependency) {
        pending.push(dependency);
      }
    }
    for (const property of wrapper.getPropertiesMetadata() ?? []) {
      pending.push(property.wrapper);
    }
    for (const enhancer of wrapper.getEnhancersMetadata() ?? []) {
      pending.push(enhancer);
    }
  }
  return true;
}

export interface InstanceEntry {
  readonly name: string;
  readonly instance: AuthLike;
  readonly options: BetterAuthRuntimeOptions<AuthLike>;
  readonly staticOptions: BetterAuthStaticOptions;
  readonly sources: readonly PrincipalSource[];
  readonly handle: AuthHandle;
  readonly context: AuthContextView;
  readonly origin: OriginCheck;
  readonly bridge: BridgeHandle;
  readonly credentialHeaders: readonly string[];
}
export interface InstanceLookup {
  get(name: string): InstanceEntry;
  list(): readonly InstanceEntry[];
}
export interface InstanceRegistration {
  readonly name: string;
  readonly instance: AuthLike;
  readonly options: BetterAuthRuntimeOptions<AuthLike>;
  readonly staticOptions: BetterAuthStaticOptions;
  readonly appOptions: BetterAuthAppOptions;
  readonly sources: readonly PrincipalSource[];
  readonly handle: AuthHandle;
}

export function configurationIssue(
  error: unknown,
  code: string,
  detail: string,
): BetterAuthConfigurationError {
  if (isConfigurationError(error)) {
    return error;
  }
  const issue = new BetterAuthConfigurationError(code, detail);
  Object.defineProperty(issue, "cause", { value: error });
  return issue;
}

export class InstanceRegistry implements InstanceLookup {
  readonly #registrations: InstanceRegistration[] = [];
  readonly #entries = new Map<string, InstanceEntry>();
  readonly logger = new Logger("BetterAuth");
  readonly diagnostics = new OriginDiagnostics(this.logger);
  state: "new" | "initialized" | "bootstrapped" = "new";
  adapter: AbstractHttpAdapter | null = null;
  owner = { description: "Nest application" };

  constructor(@Inject(REQUEST_SCOPE) private readonly scope: RequestScope) {}

  register(
    options: BetterAuthRuntimeOptions<AuthLike>,
    staticOptions: BetterAuthStaticOptions,
    sources: readonly PrincipalSource[],
    appOptions: BetterAuthAppOptions,
  ): InstanceRegistration {
    const name = staticOptions.name || "default";
    const registration: InstanceRegistration = {
      name,
      options,
      staticOptions,
      sources,
      appOptions,
      instance: options.auth,
      handle: createAuthHandle(name, options.auth, this.scope, () =>
        this.get(name),
      ),
    };
    this.#registrations.push(registration);
    return registration;
  }

  registrations(): readonly InstanceRegistration[] {
    return [...this.#registrations];
  }

  get(name: string): InstanceEntry {
    const entry = this.#entries.get(name);
    if (!entry) {
      throw new BetterAuthConfigurationError(
        "UNKNOWN_INSTANCE",
        `Auth instance '${name}' is unknown or not initialized.`,
        "Register the instance once with BetterAuthModule.forRoot().",
      );
    }
    return entry;
  }

  list(): readonly InstanceEntry[] {
    return [...this.#entries.values()];
  }

  begin(adapter: AbstractHttpAdapter | null): boolean {
    if (this.state !== "new") {
      if (this.adapter !== adapter) {
        throw new BetterAuthConfigurationError(
          "LATE_HTTP_ADAPTER",
          "Another application changed the active HTTP adapter.",
          "Close the first application before creating another.",
        );
      }
      return false;
    }
    this.adapter = adapter;
    this.state = "initialized";
    this.owner = {
      description: `Nest application ${globalThis.crypto.randomUUID()}`,
    };
    return true;
  }

  async initialize(issues: BetterAuthConfigurationError[]): Promise<void> {
    this.#entries.clear();
    const seen = new Set<string>();
    const bridgeOwners = new Map<BridgeHandle, string>();
    const shared = new Set<string>();
    let globals = 0;
    for (const registration of this.#registrations) {
      const {
        name,
        instance,
        options,
        staticOptions,
        appOptions,
        sources,
        handle,
      } = registration;
      if (seen.has(name)) {
        issues.push(
          new BetterAuthConfigurationError(
            "DUPLICATE_INSTANCE",
            `Instance '${name}' was registered more than once.`,
            "Import BetterAuthModule.forRoot() once per instance.",
          ),
        );
      }
      seen.add(name);
      if (staticOptions.globalGuard ?? name === "default") {
        globals++;
      }
      if (
        name !== "default" &&
        (appOptions.platforms !== undefined ||
          appOptions.transports !== undefined)
      ) {
        issues.push(
          new BetterAuthConfigurationError(
            "APP_EXTENSIONS_ON_NAMED_INSTANCE",
            `Instance '${name}' declares app-wide extensions.`,
            "Declare platforms and transports on the default instance.",
          ),
        );
      }
      if (
        !instance ||
        typeof instance.handler !== "function" ||
        typeof instance.api?.getSession !== "function" ||
        typeof instance.$context?.then !== "function"
      ) {
        issues.push(
          new BetterAuthConfigurationError(
            "NOT_AN_AUTH_INSTANCE",
            `Instance '${name}' must be the object returned by betterAuth().`,
          ),
        );
        continue;
      }
      let context: AuthContextView;
      try {
        context = (await instance.$context) as AuthContextView;
      } catch (error) {
        issues.push(
          configurationIssue(
            error,
            "AUTH_CONTEXT_FAILED",
            `Instance '${name}' failed to initialize its auth context.`,
          ),
        );
        continue;
      }
      const plugin = context.getPlugin("nestjs-slightly-better-auth");
      const bridge =
        plugin && typeof plugin === "object"
          ? (Reflect.get(plugin, BRIDGE_HANDLE) as BridgeHandle | undefined)
          : undefined;
      if (!bridge) {
        issues.push(
          new BetterAuthConfigurationError(
            "PLUGIN_MISSING",
            `Instance '${name}' has no nestjs() bridge.`,
            "Add nestjs() as the LAST betterAuth plugins entry.",
          ),
        );
        continue;
      }
      if (bridge.protocol !== 4 || typeof bridge.bind !== "function") {
        issues.push(
          new BetterAuthConfigurationError(
            "PLUGIN_PROTOCOL_MISMATCH",
            `Instance '${name}' has bridge protocol ${bridge.protocol}; expected 4.`,
            "Align the module and plugin package versions.",
          ),
        );
        continue;
      }
      const previous = bridgeOwners.get(bridge);
      if (previous !== undefined) {
        shared.add(name);
        shared.add(previous);
        issues.push(
          new BetterAuthConfigurationError(
            "PLUGIN_SHARED_BETWEEN_INSTANCES",
            `'${previous}' and '${name}' share one plugin object.`,
            "Call nestjs() separately inside every betterAuth() construction.",
          ),
        );
      }
      bridgeOwners.set(bridge, name);
      const plugins = context.options.plugins ?? [];
      const index = plugins.findIndex(
        (value) => value.id === "nestjs-slightly-better-auth",
      );
      if (
        index >= 0 &&
        plugins.slice(index + 1).some((value) => value.hooks?.after?.length)
      ) {
        this.logger.warn(
          `W_PLUGIN_NOT_LAST: '${name}': put nestjs() after plugins with after hooks.`,
        );
      }
      const credentialHeaders = [
        ...new Set(
          sources
            .flatMap((source) => source.credentialHeaders ?? [])
            .map((value) => value.toLowerCase()),
        ),
      ];
      this.#entries.set(name, {
        name,
        instance,
        options,
        staticOptions,
        sources,
        handle,
        context,
        bridge,
        credentialHeaders,
        origin: new OriginCheck(this.scope, {
          instance: name,
          context,
          options: options.originCheck,
          diagnostics: this.diagnostics,
          credentialHeaders,
          exposeRawCause: options.errors?.exposeRawCause,
        }),
      });
    }
    for (const name of shared) {
      this.#entries.delete(name);
    }
    if (globals > 1) {
      issues.push(
        new BetterAuthConfigurationError(
          "DUPLICATE_GLOBAL_GUARD",
          "More than one registration enables the global guard.",
          "Enable globalGuard on only one instance.",
        ),
      );
    }
    if (!seen.has("default")) {
      issues.push(
        new BetterAuthConfigurationError(
          "NO_DEFAULT_INSTANCE",
          "Named registrations require one default instance.",
          "Add BetterAuthModule.forRoot({ auth }).",
        ),
      );
    }
  }

  reset(): void {
    this.state = "new";
    this.#entries.clear();
  }
}
