import type {
  AuthContextView,
  AuthHandle,
  ScopeInit,
} from "./auth-contracts.js";
import { BetterAuthConfigurationError } from "./auth-errors.js";
import type { AuthLike } from "./auth-types.js";
import type { BridgeBinding, ScopeView } from "./bridge-protocol.js";
import type { InstanceEntry } from "./instance-registry.js";
import type { RequestScope, ScopeState } from "./request-scope.js";
import { TrustedOrigins } from "./trusted-origins.js";

/** Preserve capabilities lazily; spreading a ScopeView can extract credentials. */
export function derivedScope(scope: RequestScope, init: ScopeInit): ScopeState {
  const outer = scope.current();
  const view: ScopeView = {
    get cookies() {
      return init.cookies;
    },
    get forward() {
      return init.forward ?? "same-credential";
    },
    get inbound() {
      return init.inbound;
    },
    get internal() {
      return init.internal ?? false;
    },
    get browserHeaders() {
      return outer?.view.browserHeaders;
    },
    get checkCallerSession() {
      return outer?.view.checkCallerSession;
    },
  };
  return {
    view,
    get call() {
      return outer?.call;
    },
    get plan() {
      return outer?.plan;
    },
    get reading() {
      return outer?.reading;
    },
  };
}

export function createAuthHandle(
  name: string,
  instance: AuthLike,
  scope: RequestScope,
  ready: () => InstanceEntry,
): AuthHandle {
  const context = (): Promise<AuthContextView> =>
    instance.$context as Promise<AuthContextView>;
  const trusted = new TrustedOrigins(context);
  return {
    name,
    instance,
    get api() {
      return instance.api;
    },
    context,
    async hasPlugin(id) {
      return (await context()).hasPlugin(id);
    },
    run<T>(init: ScopeInit, fn: () => Promise<T>): Promise<T> {
      return scope.run(derivedScope(scope, init), fn);
    },
    checkOrigin(browser, mode) {
      return ready().origin.check(browser, mode);
    },
    producedByEndpoint(value) {
      return ready().bridge.producedByEndpoint(value);
    },
    isTrustedOrigin(origin, request) {
      return trusted.isTrusted(origin, request);
    },
  };
}

export class BridgeClient {
  readonly #registrations: { binding: BridgeBinding; close: () => void }[] = [];

  bind(
    entry: InstanceEntry,
    binding: BridgeBinding,
  ): { tookOverFrom?: string } {
    const result = entry.bridge.bind(binding);
    this.#registrations.push({ binding, close: result.close });
    return result;
  }

  bootstrap(): void {
    const displaced = this.#registrations.filter(
      ({ binding }) => binding.state === "displaced",
    );
    if (displaced.length) {
      throw new BetterAuthConfigurationError(
        "INSTANCE_ALREADY_BOUND",
        `Another application bound ${displaced.map(({ binding }) => `'${binding.instance}'`).join(", ")} while this application initialized.`,
        "Initialize applications that share a Better Auth instance one after another, and close one before the next binds.",
      );
    }
    for (const { binding } of this.#registrations) {
      binding.state = "bootstrapped";
    }
  }

  close(): void {
    for (const registration of this.#registrations) {
      registration.close();
    }
    this.#registrations.length = 0;
  }
}
