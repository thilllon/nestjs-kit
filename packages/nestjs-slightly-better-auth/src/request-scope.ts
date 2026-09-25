import { AsyncLocalStorage } from "node:async_hooks";
import type {
  AuthorizationDecision,
  InvocationLineage,
  PrincipalReading,
  PrincipalResult,
  RoutePlan,
  TransportCall,
} from "./auth-contracts.js";
import {
  AuthFailures,
  type AuthFailure,
  isConfigurationError,
} from "./auth-errors.js";
import type { ScopeView } from "./bridge-protocol.js";

export interface ScopeState {
  readonly view: ScopeView;
  readonly call?: TransportCall;
  readonly plan?: RoutePlan;
  readonly reading?: () => PrincipalReading;
}
/** A requirement's decision and the invocation values of the policy runs that produced an allow. */
export interface DecisionOutcome {
  readonly decision: AuthorizationDecision;
  readonly published: readonly ReadonlyMap<symbol, unknown>[];
}
export interface RequestState {
  readonly principal: Map<string, Promise<PrincipalResult>>;
  readonly policyIo: Map<string, Promise<unknown>>;
  readonly decisions: Map<string, Promise<DecisionOutcome>>;
  readonly values: Map<symbol, unknown>;
  readonly authorizationCalls: Set<string>;
  readonly origins: Map<string, Promise<AuthFailure | null>>;
  readonly surfaced: Set<string>;
  readonly connections: Map<
    string,
    {
      value: Extract<PrincipalResult, { outcome: "authenticated" | "absent" }>;
      expiresAt: number;
    }
  >;
}

const SURFACED = Symbol.for("nestjs-slightly-better-auth:surfaced");
export function memoKey(
  instance: string,
  ...inputs: readonly unknown[]
): string {
  return JSON.stringify([instance, ...inputs]);
}

/** Shared by guards and readers that have only the transport's structural lineage. */
export function surfacedRecord(
  key: object,
  lineage?: InvocationLineage,
): Set<string> {
  const carrier = lineage?.carrier ?? key;
  const partition = lineage ? lineage.position.split(":", 1)[0]! : "";
  let records = Reflect.get(carrier, SURFACED) as
    | Map<string, Set<string>>
    | undefined;
  if (!records) {
    records = new Map();
    Object.defineProperty(carrier, SURFACED, { value: records });
  }
  let record = records.get(partition);
  if (!record) {
    record = new Set();
    records.set(partition, record);
  }
  return record;
}

export class RequestScope {
  readonly #storage = new AsyncLocalStorage<ScopeState>();
  readonly #states = new WeakMap<object, RequestState>();
  readonly #valueKeys = new Map<string, Map<symbol, symbol>>();
  readonly #errorIds = new WeakMap<object, number>();
  #nextError = 0;

  run<T>(state: ScopeState, fn: () => T): T {
    return this.#storage.run(state, fn);
  }

  exit<T>(fn: () => T): T {
    return this.#storage.exit(fn);
  }

  current(): ScopeState | undefined {
    return this.#storage.getStore();
  }

  stateFor(key: object): RequestState {
    let state = this.#states.get(key);
    if (!state) {
      state = {
        principal: new Map(),
        policyIo: new Map(),
        decisions: new Map(),
        values: new Map(),
        authorizationCalls: new Set(),
        origins: new Map(),
        surfaced: new Set(),
        connections: new Map(),
      };
      this.#states.set(key, state);
    }
    return state;
  }

  memoPrincipal(
    call: Pick<TransportCall, "key" | "connection" | "principalTtlMs">,
    input: {
      instance: string;
      freshness: "default" | "authoritative";
      sourceSet: string;
    },
    compute: () => Promise<PrincipalResult>,
  ): Promise<PrincipalResult> {
    const key = memoKey(input.instance, input.freshness, input.sourceSet);
    const state = this.stateFor(call.key);
    const existing = state.principal.get(key);
    if (existing) {
      return existing;
    }
    const connection =
      call.connection &&
      input.freshness !== "authoritative" &&
      (call.principalTtlMs ?? 0) > 0
        ? this.stateFor(call.connection).connections
        : undefined;
    const cached = connection?.get(key);
    const promise = Promise.resolve().then(async () => {
      if (cached && cached.expiresAt > Date.now()) {
        return cached.value;
      }
      connection?.delete(key);
      try {
        const value = await compute();
        if (value.outcome !== "rejected") {
          connection?.set(key, {
            value,
            expiresAt: Date.now() + (call.principalTtlMs ?? 0),
          });
        }
        return value;
      } catch (error) {
        connection?.delete(key);
        throw error;
      }
    });
    state.principal.set(key, promise);
    return promise;
  }

  memoPolicyIo<T>(
    request: object,
    instance: string,
    concreteKey: string,
    compute: () => Promise<T>,
    limit: number | false = 100,
  ): Promise<T> {
    const state = this.stateFor(request);
    const key = memoKey(instance, concreteKey);
    const existing = state.policyIo.get(key);
    if (existing) {
      return existing as Promise<T>;
    }
    if (
      limit !== false &&
      [...state.authorizationCalls].filter(
        (entry) => JSON.parse(entry)[0] === instance,
      ).length >= limit
    ) {
      return Promise.reject(
        AuthFailures.rejected({
          status: 429,
          reason: "TOO_MANY_AUTHORIZATION_CHECKS",
        }),
      );
    }
    state.authorizationCalls.add(key);
    const promise = Promise.resolve().then(compute);
    state.policyIo.set(key, promise);
    return promise;
  }

  memoDecision(
    invocation: object,
    instance: string,
    concreteKey: string,
    compute: () => Promise<DecisionOutcome>,
  ): Promise<DecisionOutcome> {
    const decisions = this.stateFor(invocation).decisions;
    const key = memoKey(instance, concreteKey);
    let promise = decisions.get(key);
    if (!promise) {
      promise = Promise.resolve().then(compute);
      decisions.set(key, promise);
    }
    return promise;
  }

  valueKey(instance: string, key: symbol): symbol {
    let keys = this.#valueKeys.get(instance);
    if (!keys) {
      keys = new Map();
      this.#valueKeys.set(instance, keys);
    }
    let namespaced = keys.get(key);
    if (!namespaced) {
      namespaced = Symbol(key.description);
      keys.set(key, namespaced);
    }
    return namespaced;
  }

  surfaced(
    key: object,
    error: object,
    context: { instance: string; site: string; lineage?: InvocationLineage },
  ): boolean {
    let id = this.#errorIds.get(error);
    if (!id) {
      id = ++this.#nextError;
      this.#errorIds.set(error, id);
    }
    const reason = isConfigurationError(error)
      ? memoKey(context.instance, error.code, context.site)
      : `error:${id}`;
    const carrier = surfacedRecord(key, context.lineage);
    const state =
      key === context.lineage?.carrier ? carrier : this.stateFor(key).surfaced;
    const repeated = state.has(reason) || carrier.has(reason);
    state.add(reason);
    carrier.add(reason);
    return repeated;
  }
}
