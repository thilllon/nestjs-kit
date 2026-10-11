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
  /** The one weak reference to the context that the registry stores. */
  readonly ref: WeakRef<DispatchContext>;
  /** True when `target` is an instance the application's container holds. */
  owns(target: object): boolean;
  /** True when the application advises a member of `owner`. */
  weaves(owner: Class): boolean;
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
  /** Detaches the application from the classes it examined. */
  close(): void;
}

/**
 * The registry refers to contexts weakly: an application that is abandoned
 * without `close()`, such as one whose bootstrap failed, leaves the registry
 * when it is garbage collected, and no registry entry keeps a container alive.
 */
interface WeavingRegistry {
  /** The context each object was last attributed to. */
  readonly instances: WeakMap<object, WeakRef<DispatchContext>>;
  /** Contexts that examined a class, woven or not, in creation order. */
  readonly types: WeakMap<Class, WeakRef<DispatchContext>[]>;
  /** The context of each Nest container, keyed by its `ModulesContainer`. */
  readonly containers: WeakMap<object, WeakRef<DispatchContext>>;
}

/**
 * The registry is a property of `globalThis` under a `Symbol.for` key: class
 * prototypes are shared by every application and every copy of the package in
 * the process, so the stubs on them need one registry.
 */
const REGISTRY: unique symbol = Symbol.for("nestjs-aspect:weaving-registry");

function weavingRegistry(): WeavingRegistry {
  const host = globalThis as { [REGISTRY]?: WeavingRegistry };
  host[REGISTRY] ??= {
    instances: new WeakMap(),
    types: new WeakMap(),
    containers: new WeakMap(),
  };
  return host[REGISTRY];
}

const { instances, types, containers } = weavingRegistry();

function isLive(
  context: DispatchContext | undefined,
): context is DispatchContext {
  return context !== undefined && !context.closed;
}

/** The live contexts that examined `type`; drops the entries of the others. */
function liveContexts(type: Class): DispatchContext[] {
  const refs = types.get(type);
  if (!refs) {
    return [];
  }
  const live = refs.map((ref) => ref.deref()).filter(isLive);
  if (live.length === 0) {
    types.delete(type);
  } else if (live.length !== refs.length) {
    types.set(
      type,
      live.map((context) => context.ref),
    );
  }
  return live;
}

/** The class whose prototype `target` has directly. */
function classOf(target: object): Class | undefined {
  const prototype: unknown = Object.getPrototypeOf(target);
  const type = isObject(prototype) ? prototype.constructor : undefined;
  return typeof type === "function" ? (type as Class) : undefined;
}

/**
 * Makes `context` the weaving context of a Nest container. Returns the live
 * context the container already has, which then keeps the container.
 */
export function claimContainer(
  container: object,
  context: DispatchContext,
): DispatchContext | undefined {
  const existing = containers.get(container)?.deref();
  if (isLive(existing) && existing !== context) {
    return existing;
  }
  containers.set(container, context.ref);
  return undefined;
}

/**
 * The live context that advises `target` through a stub installed on
 * `owner`, or `undefined` when the call runs the original function.
 *
 * 1. An object attributed to a live context keeps it.
 * 2. Otherwise the live context whose container holds the object takes it,
 *    whether or not that application advises the member: an application that
 *    excludes the class or matches nothing in it runs the original function
 *    for its own instances.
 * 3. An object no live container holds runs the original function when it was
 *    attributed before: it belongs to an application that is closed or gone.
 * 4. Any other object, such as a request-scoped or transient instance or one
 *    created with `new`, goes to the most recently created live context that
 *    weaves `owner`; that context reports the fallback when there are several.
 */
export function resolveContext(
  target: unknown,
  owner: Class,
): DispatchContext | undefined {
  if (!isObject(target)) {
    return undefined;
  }
  const attribution = instances.get(target);
  const attributed = attribution?.deref();
  if (isLive(attributed)) {
    return attributed;
  }
  const type = classOf(target);
  const holder = type && liveContexts(type).find((c) => c.owns(target));
  if (holder) {
    instances.set(target, holder.ref);
    return holder;
  }
  if (attribution) {
    return undefined;
  }
  const weaving = liveContexts(owner).filter((c) => c.weaves(owner));
  const context = weaving.at(-1);
  if (!context) {
    return undefined;
  }
  if (weaving.length > 1) {
    context.reportAmbiguous(owner);
  }
  instances.set(target, context.ref);
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
  readonly ref: WeakRef<DispatchContext> = new WeakRef(this);

  private isClosed = false;

  private readonly members = new Map<
    Class,
    Map<string | symbol, MemberKinds>
  >();

  /** Classes the weaver examined, woven or not. */
  private readonly examined = new Set<Class>();

  /** Examined classes whose instances are never advised. */
  private readonly excluded = new Set<Class>();

  private readonly reported = new Set<Class>();

  constructor(private readonly options: WeavingContextOptions) {}

  get closed(): boolean {
    return this.isClosed;
  }

  /**
   * Records that the weaver examined `type`, which makes this context a
   * candidate for the instances of the class, and drops the members recorded
   * for it; `setMember` then records the members that match.
   */
  examine(type: Class): void {
    this.members.delete(type);
    if (this.examined.has(type)) {
      return;
    }
    this.examined.add(type);
    types.set(type, [...(types.get(type) ?? []), this.ref]);
  }

  /** Examines `type` as a class whose instances this context never advises. */
  exclude(type: Class): void {
    this.examine(type);
    this.excluded.add(type);
  }

  /** Records a woven member of an examined class. */
  setMember(method: MethodRef, advisors: readonly WeavingAdvisor[]): void {
    const type = method.targetType;
    let byName = this.members.get(type);
    if (!byName) {
      byName = new Map();
      this.members.set(type, byName);
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
    const type = classOf(target);
    if (!type || !this.examined.has(type)) {
      return false;
    }
    for (const instance of this.options.instancesOf(type)) {
      if (instance === target) {
        return true;
      }
    }
    return false;
  }

  weaves(owner: Class): boolean {
    return this.members.has(owner);
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

  /**
   * Detaches the context: its stubs then run the original functions. The
   * instances its container holds stay attributed to it, so no other
   * application adopts them unless its own container holds them too.
   */
  close(): void {
    if (this.isClosed) {
      return;
    }
    for (const type of this.examined) {
      for (const instance of this.options.instancesOf(type)) {
        if (isObject(instance) && !isLive(instances.get(instance)?.deref())) {
          instances.set(instance, this.ref);
        }
      }
    }
    this.isClosed = true;
    for (const type of this.examined) {
      liveContexts(type);
    }
  }

  /**
   * True for an instance of a subclass that reaches the owner's stub while
   * its own class is excluded, or by inheritance while its own class was
   * examined and matched no advisor for the member. A `super` call from an
   * override of a class that is not excluded is an execution of the owner's
   * member and stays advised.
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
      const type = prototype.constructor as Class;
      unadvised = this.examined.has(type);
      for (
        let current: object | null = prototype;
        unadvised && current && current !== owner.prototype;
        current = Object.getPrototypeOf(current)
      ) {
        if (Object.hasOwn(current, member.method.name)) {
          unadvised = false;
        }
      }
      unadvised ||= this.excluded.has(type);
      member.unadvised.set(prototype, unadvised);
    }
    return unadvised;
  }
}
