// The weaving state of one Nest application, and the process-wide registry
// through which a dispatcher stub finds the application an object belongs to.

import { sortAdvisors } from "./aspect-compiler";
import { buildChain, invoke } from "./invocation";
import type {
  AdvisorDescriptor,
  ChainOptions,
  Class,
  Fn,
  InterceptorChain,
  JoinPointKind,
  MethodRef,
  PointcutLike,
} from "./types";
import { isObject } from "./util";

/**
 * What a dispatcher stub needs from the application an object belongs to.
 * Stubs and contexts of two copies of the package, such as the CommonJS build
 * next to the ES module build, meet through this interface.
 */
export interface DispatchContext {
  /** True once the application shut down. */
  readonly closed: boolean;
  /** True when `target` is an instance the application's container holds. */
  owns(target: object): boolean;
  /**
   * Runs the interceptor chain of the member `name` of `owner` for one call,
   * or `original` when the application does not advise the member.
   */
  dispatch(
    owner: Class,
    name: string | symbol,
    kind: JoinPointKind,
    target: object,
    args: readonly unknown[],
    original: Fn,
  ): unknown;
  /** Reports, once per class, that an object was attributed by fallback. */
  reportAmbiguous(owner: Class): void;
}

interface WeavingRegistry {
  /** The context each object was attributed to on its first advised call. */
  readonly instances: WeakMap<object, DispatchContext>;
  /** Live contexts that wove a class, in creation order. */
  readonly types: WeakMap<Class, DispatchContext[]>;
}

/**
 * The registry is a property of `globalThis` under a `Symbol.for` key: class
 * prototypes are shared by every application and every copy of the package in
 * the process, so the stubs on them need one registry.
 */
const REGISTRY: unique symbol = Symbol.for("nestjs-aspect:weaving-registry");

function weavingRegistry(): WeavingRegistry {
  const host = globalThis as { [REGISTRY]?: WeavingRegistry };
  host[REGISTRY] ??= { instances: new WeakMap(), types: new WeakMap() };
  return host[REGISTRY];
}

const { instances, types } = weavingRegistry();

/**
 * The live context that advises `target` through a stub installed on
 * `owner`, or `undefined` when the call runs the original function.
 *
 * - An object already attributed keeps its context; after that application
 *   shut down, its calls run the original function.
 * - Otherwise the live contexts that wove `owner` decide: none leaves the
 *   object unadvised; a single one takes it; of several, the one whose
 *   container holds the object takes it, and an object no container holds
 *   (a request-scoped or transient instance) goes to the most recently
 *   created one, which reports the fallback.
 */
export function resolveContext(
  target: unknown,
  owner: Class,
): DispatchContext | undefined {
  if (!isObject(target)) {
    return undefined;
  }
  const attributed = instances.get(target);
  if (attributed) {
    return attributed.closed ? undefined : attributed;
  }
  const live = types.get(owner);
  if (!live || live.length === 0) {
    return undefined;
  }
  let context = live.length === 1 ? live[0] : live.find((c) => c.owns(target));
  if (!context) {
    context = live[live.length - 1];
    context.reportAmbiguous(owner);
  }
  instances.set(target, context);
  return context;
}

/** An advisor as the weaver matched it against a member. */
export interface WeavingAdvisor {
  readonly pointcut: PointcutLike;
  /** Aspect class or `@Advisor` class. */
  readonly type: Class;
  /**
   * The descriptor that orders the advisor and supplies its advice. Throws
   * `AspectNotReadyError` while the instance of an `@Advisor` class that
   * `method` needs does not exist.
   */
  describe(method: MethodRef): AdvisorDescriptor;
}

/** One woven member of one application. */
export interface WovenMember {
  readonly method: MethodRef;
  /** The advisors whose pointcut matched statically, in registration order. */
  readonly advisors: readonly WeavingAdvisor[];
}

interface MemberState extends WovenMember {
  /** Built on the first call. */
  chain?: InterceptorChain;
  /**
   * Per prototype of a subclass instance: true when the instance inherits
   * the stub from the owner although its own class matched no advisor.
   */
  readonly unadvised: WeakMap<object, boolean>;
}

type MemberKinds = Partial<Record<JoinPointKind, MemberState>>;

export interface WeavingContextOptions {
  readonly chain: ChainOptions;
  /** Static and static-transient instances the container holds for a class. */
  instancesOf(type: Class): Iterable<unknown>;
  warn(message: string): void;
}

/**
 * The woven members of one Nest application and their interceptor chains.
 * A chain is built on the first call of its member and cached for the
 * lifetime of the context.
 */
export class WeavingContext implements DispatchContext {
  private isClosed = false;

  private readonly members = new Map<
    Class,
    Map<string | symbol, MemberKinds>
  >();

  /** Classes the weaver examined, woven or not. */
  private readonly examined = new Set<Class>();

  private readonly reported = new Set<Class>();

  constructor(private readonly options: WeavingContextOptions) {}

  get closed(): boolean {
    return this.isClosed;
  }

  /**
   * Records that the weaver examined `type` and drops the members recorded
   * for it; `setMember` then records the members that match.
   */
  examine(type: Class): void {
    this.examined.add(type);
    this.members.delete(type);
  }

  /** Records a woven member and makes this context a candidate for its class. */
  setMember(method: MethodRef, advisors: readonly WeavingAdvisor[]): void {
    const type = method.targetType;
    let byName = this.members.get(type);
    if (!byName) {
      byName = new Map();
      this.members.set(type, byName);
      const live = types.get(type) ?? [];
      if (!live.includes(this)) {
        types.set(type, [...live, this]);
      }
    }
    const kinds = byName.get(method.name) ?? {};
    kinds[method.kind] = { method, advisors, unadvised: new WeakMap() };
    byName.set(method.name, kinds);
  }

  /** Woven members of a class, in the order they were recorded. */
  *membersOf(type: Class): Generator<WovenMember> {
    for (const kinds of this.members.get(type)?.values() ?? []) {
      yield* Object.values(kinds);
    }
  }

  /** Classes with at least one woven member. */
  wovenTypes(): Class[] {
    return [...this.members.keys()];
  }

  owns(target: object): boolean {
    const prototype: unknown = Object.getPrototypeOf(target);
    const type = isObject(prototype) ? prototype.constructor : undefined;
    if (typeof type !== "function") {
      return false;
    }
    for (const instance of this.options.instancesOf(type as Class)) {
      if (instance === target) {
        return true;
      }
    }
    return false;
  }

  dispatch(
    owner: Class,
    name: string | symbol,
    kind: JoinPointKind,
    target: object,
    args: readonly unknown[],
    original: Fn,
  ): unknown {
    const member = this.members.get(owner)?.get(name)?.[kind];
    if (!member || this.inheritsUnadvised(member, owner, target)) {
      return original.apply(target, args as unknown[]);
    }
    member.chain ??= buildChain(
      member.method,
      sortAdvisors(
        member.advisors.map((advisor) => advisor.describe(member.method)),
      ),
      this.options.chain,
    );
    return invoke(member.chain, target, args);
  }

  reportAmbiguous(owner: Class): void {
    if (this.reported.has(owner)) {
      return;
    }
    this.reported.add(owner);
    this.options.warn(
      `Several live applications weave ${owner.name}. An instance that no container holds, such as a request-scoped or transient one, is advised by the most recently created application.`,
    );
  }

  /** Unregisters the context; its stubs then run the original functions. */
  close(): void {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;
    for (const type of this.members.keys()) {
      const live = (types.get(type) ?? []).filter((c) => c !== this);
      if (live.length === 0) {
        types.delete(type);
      } else {
        types.set(type, live);
      }
    }
  }

  /**
   * True for an instance of a subclass that reaches the owner's stub by
   * inheritance while its own class was examined and matched no advisor for
   * the member. A `super` call from an override is an execution of the
   * owner's member and stays advised.
   */
  private inheritsUnadvised(
    member: MemberState,
    owner: Class,
    target: object,
  ): boolean {
    const prototype: object | null = Object.getPrototypeOf(target);
    if (prototype === null || prototype === owner.prototype) {
      return false;
    }
    let unadvised = member.unadvised.get(prototype);
    if (unadvised === undefined) {
      unadvised = this.examined.has(prototype.constructor as Class);
      for (
        let current: object | null = prototype;
        unadvised && current && current !== owner.prototype;
        current = Object.getPrototypeOf(current)
      ) {
        if (Object.hasOwn(current, member.method.name)) {
          unadvised = false;
        }
      }
      member.unadvised.set(prototype, unadvised);
    }
    return unadvised;
  }
}
