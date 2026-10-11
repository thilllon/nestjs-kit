// The process-wide registry through which a dispatcher stub finds the
// application an object belongs to.

import { AspectConfigurationError, AspectUsageError } from "./errors";
import type { Class, AnyFunction, JoinPointKind } from "./types";
import { constructorChain, isObject } from "./util";

/**
 * What a dispatcher stub needs from the application an object belongs to.
 * Stubs and contexts of two copies of the package, such as the CommonJS build
 * next to the ES module build, meet through this interface.
 */
export interface DispatchContext {
  /** True once the application shut down. */
  readonly closed: boolean;
  /**
   * True when the application raises `AspectUsageError` for a call on an
   * object that several applications could advise, instead of choosing one.
   */
  readonly strict: boolean;
  /** The one weak reference to the context that the registry stores. */
  readonly ref: WeakRef<DispatchContext>;
  /**
   * The reference to the context that the registry stores with each object
   * the application owns; the context empties it when it closes.
   */
  readonly handle: ContextHandle;
  /**
   * How the application's container holds `target`: `"created"` for the
   * instance of a class provider, which the container constructed,
   * `"held"` for the instance of a factory or value provider, `undefined`
   * for an object the container does not hold.
   */
  owns(target: object): Ownership | undefined;
  /** True when the application advises a member of `owner`. */
  weaves(owner: Class): boolean;
  /**
   * Runs the interceptor chain of the member `name` of `owner` for one call,
   * or `original` when the application does not advise the member. `target`
   * is the `this` of the call, which is no object for a detached call.
   */
  dispatch(
    owner: Class,
    name: string | symbol,
    kind: JoinPointKind,
    target: object,
    args: readonly unknown[],
    original: AnyFunction,
  ): unknown;
  /**
   * The delegate that implements the introduced interface `token` for
   * `target`, created on first use; `undefined` when no aspect of the
   * application introduces the interface into the class of `target`.
   */
  introduction(target: object, token: Class): object | undefined;
  /** Logs `message` once per class: a call was attributed by choice. */
  reportAmbiguous(owner: Class, message: string): void;
  /** Detaches the application from the classes it examined. */
  close(): void;
}

/** How the container of an application came to hold an object. */
export type Ownership = "created" | "held";

/**
 * A strong reference to a context that the context itself empties when it
 * closes. The registry stores it with the objects the application owns: an
 * application stays live while one of its objects is reachable, and a closed
 * application is not kept in memory by the objects that outlive it.
 */
export interface ContextHandle {
  context: DispatchContext | undefined;
}

/** A context that owns an object. */
interface Owner {
  readonly handle: ContextHandle;
  ownership: Ownership;
}

/** What the registry knows about the applications of one object. */
interface Attribution {
  /** Contexts whose container holds the object or created it. */
  owners: Owner[];
  /** Handles of the closed contexts whose container created the object. */
  readonly creators: ContextHandle[];
  /** Registry generation at which the containers were searched for it. */
  searched: number;
}

/** A dispatcher stub as the copy of the package that created it recorded it. */
export interface StubRecord {
  /** The class on whose prototype the stub is installed. */
  readonly owner: Class;
  /** The function the stub replaced. */
  readonly original: AnyFunction;
  /**
   * True for the stub of a member that only an introduction adds: `original`
   * then is no member of the class, it raises `AspectUsageError`.
   */
  readonly introduced?: boolean;
  /**
   * Handles of the contexts in which the member carries an annotation that
   * requires advice: the stub never runs `original` for an object such an
   * application created.
   */
  readonly required: WeakSet<ContextHandle>;
}

/**
 * The registry refers to a context strongly only from the objects the
 * application owns, as the value of a `WeakMap` entry whose key is the
 * object. An application therefore stays live as long as one of its objects
 * is reachable, also when nothing else refers to its container. An
 * application that is abandoned without `close()`, such as one whose
 * bootstrap failed, leaves the registry when it is garbage collected with
 * its objects.
 */
export interface WeavingRegistry {
  /** The applications of each object a stub was called on. */
  readonly attributions: WeakMap<object, Attribution>;
  /** Contexts that examined a class, woven or not, in creation order. */
  readonly types: WeakMap<Class, WeakRef<DispatchContext>[]>;
  /** The context of each Nest container, keyed by its `ModulesContainer`. */
  readonly containers: WeakMap<object, WeakRef<DispatchContext>>;
  /**
   * The dispatcher stubs the package created. A function is a stub because
   * it is a key of this map, never because of a property it carries.
   */
  readonly stubs: WeakMap<AnyFunction, StubRecord>;
  /**
   * `generation` grows whenever the classes or instances of an application
   * change: a context examines a class, completes its weaving or closes.
   */
  readonly epoch: { generation: number };
}

/**
 * The registry is a property of `globalThis` under a `Symbol.for` key: class
 * prototypes are shared by every application and every copy of the package in
 * the process, so the stubs on them need one registry.
 */
const REGISTRY: unique symbol = Symbol.for("nestjs-aspect:weaving-registry");

const REGISTRY_MAPS = ["attributions", "types", "containers", "stubs"] as const;

/** True for a genuine `WeakMap`, whatever its prototype or own properties. */
function isWeakMap(value: unknown): boolean {
  try {
    WeakMap.prototype.has.call(value, REGISTRY_MAPS);
    return true;
  } catch {
    return false;
  }
}

function isRegistry(value: unknown): value is WeavingRegistry {
  if (!isObject(value) || !Object.isFrozen(value)) {
    return false;
  }
  const field = (name: string): unknown =>
    Object.getOwnPropertyDescriptor(value, name)?.value;
  const epoch = field("epoch");
  return (
    REGISTRY_MAPS.every((name) => isWeakMap(field(name))) &&
    isObject(epoch) &&
    typeof Object.getOwnPropertyDescriptor(epoch, "generation")?.value ===
      "number"
  );
}

/**
 * The registry of `host`, created on first use as an own property that can
 * be neither reassigned nor deleted. A registry that `host` merely inherits,
 * such as a property planted on `Object.prototype`, is ignored. Throws
 * `AspectConfigurationError` when the property holds anything but a registry:
 * the weaving state of every application depends on it.
 */
export function weavingRegistry(host: object = globalThis): WeavingRegistry {
  const descriptor = Object.getOwnPropertyDescriptor(host, REGISTRY);
  if (!descriptor) {
    const registry: WeavingRegistry = Object.freeze({
      attributions: new WeakMap(),
      types: new WeakMap(),
      containers: new WeakMap(),
      stubs: new WeakMap(),
      epoch: Object.seal({ generation: 0 }),
    });
    Object.defineProperty(host, REGISTRY, { value: registry });
    return registry;
  }
  const registry: unknown = descriptor.value;
  if (!isRegistry(registry)) {
    throw new AspectConfigurationError(
      "The global weaving registry of nestjs-aspect holds a value that no copy of the package created",
    );
  }
  return registry;
}

const { attributions, types, containers, stubs, epoch } = weavingRegistry();

/** Records `stub` as a dispatcher stub of the package. */
export function registerStub(stub: AnyFunction, record: StubRecord): void {
  stubs.set(stub, record);
}

/** The record of a dispatcher stub; `undefined` for any other value. */
export function stubRecord(value: unknown): StubRecord | undefined {
  return typeof value === "function"
    ? stubs.get(value as AnyFunction)
    : undefined;
}

function isLive(
  context: DispatchContext | undefined,
): context is DispatchContext {
  return context !== undefined && !context.closed;
}

/** The live contexts that examined `type`; drops the entries of the others. */
export function liveContexts(type: Class): DispatchContext[] {
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
export function classOf(target: object): Class | undefined {
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

function attributionOf(target: object): Attribution {
  let attribution = attributions.get(target);
  if (!attribution) {
    attribution = { owners: [], creators: [], searched: -1 };
    attributions.set(target, attribution);
  }
  return attribution;
}

function addOwner(
  attribution: Attribution,
  context: DispatchContext,
  ownership: Ownership,
): void {
  const owner = attribution.owners.find(
    (candidate) => candidate.handle === context.handle,
  );
  if (!owner) {
    attribution.owners.push({ handle: context.handle, ownership });
  } else if (ownership === "created") {
    owner.ownership = ownership;
  }
}

/** Records `context` as an owner of `target`. */
export function recordOwner(
  target: object,
  context: DispatchContext,
  ownership: Ownership,
): void {
  addOwner(attributionOf(target), context, ownership);
}

/** Makes `context` a candidate for the instances of `type`. */
export function registerType(type: Class, context: DispatchContext): void {
  types.set(type, [...(types.get(type) ?? []), context.ref]);
}

/**
 * Makes the registry search the containers again for the objects it knows:
 * the classes or instances of an application changed.
 */
export function advanceGeneration(): void {
  epoch.generation++;
}

/** A live context that owns an object. */
interface LiveOwner {
  readonly context: DispatchContext;
  readonly ownership: Ownership;
}

/**
 * The live contexts that own `target`: those that recorded it when their
 * container created or handed out the instance, and those whose container
 * holds it. The containers are searched once per registry generation.
 * `orphaned` is true once a context whose container created the object is
 * closed.
 */
function ownersOf(target: object): {
  live: LiveOwner[];
  orphaned: boolean;
} {
  const attribution = attributionOf(target);
  if (attribution.searched !== epoch.generation) {
    attribution.searched = epoch.generation;
    const type = classOf(target);
    for (const context of type ? liveContexts(type) : []) {
      const ownership = context.owns(target);
      if (ownership) {
        addOwner(attribution, context, ownership);
      }
    }
  }
  const live: LiveOwner[] = [];
  for (const { handle, ownership } of attribution.owners) {
    if (isLive(handle.context)) {
      live.push({ context: handle.context, ownership });
    } else if (ownership === "created") {
      attribution.creators.push(handle);
    }
  }
  if (live.length !== attribution.owners.length) {
    attribution.owners = attribution.owners.filter(({ handle }) =>
      isLive(handle.context),
    );
  }
  return { live, orphaned: attribution.creators.length > 0 };
}

/**
 * True when `target` is an object that a closed application created and
 * for which the member of `record` requires advice in that application.
 * `resolveContext` has examined the owners of `target` before.
 */
export function requiresClosedAdvice(
  target: unknown,
  record: StubRecord,
): boolean {
  const creators = isObject(target)
    ? attributions.get(target)?.creators
    : undefined;
  return creators?.some((handle) => record.required.has(handle)) ?? false;
}

/**
 * The one context among `candidates` that owns the objects `target` refers
 * to in its own properties, such as its injected dependencies. `undefined`
 * when they belong to no context, to several, or to one that is no candidate.
 */
function ownerOfDependencies(
  target: object,
  candidates: readonly DispatchContext[],
): DispatchContext | undefined {
  const found = new Set<DispatchContext>();
  for (const key of Reflect.ownKeys(target)) {
    const value: unknown = Object.getOwnPropertyDescriptor(target, key)?.value;
    if (typeof value === "object" && value !== null) {
      for (const { context } of ownersOf(value).live) {
        found.add(context);
      }
    }
  }
  const [context] = found;
  return found.size === 1 && candidates.includes(context) ? context : undefined;
}

/**
 * Decides between several contexts that advise `owner` for one object. A
 * strict context refuses the call with `AspectUsageError`: advising the
 * object with the aspects of one application would silently skip those of
 * the others. Without a strict context the last candidate advises the object
 * and logs `situation` once per class.
 */
function choose(
  candidates: readonly DispatchContext[],
  owner: Class,
  situation: string,
): DispatchContext {
  const message = `Several live applications advise ${owner.name}, and ${situation}.`;
  if (candidates.some((context) => context.strict)) {
    throw new AspectUsageError(
      `${message} Close the applications that are no longer used, give each application its own instance, or set the strict option of AspectModule to false in each of them to let the most recently created application advise such an instance.`,
    );
  }
  const context = candidates[candidates.length - 1];
  context.reportAmbiguous(
    owner,
    `${message} The most recently created application advises such an instance.`,
  );
  return context;
}

/**
 * The live context that advises `target` through a stub installed on
 * `owner`, or `undefined` when the call runs the original function.
 *
 * 1. An object belongs to the live context whose container created it: the
 *    instance of a class provider of any scope. That context takes the
 *    object whether or not it advises the member: an application that
 *    excludes the class or matches nothing in it runs the original function
 *    for its own instances.
 * 2. A live context whose container holds the object as the instance of a
 *    factory or value provider, or handed it out as one, takes the object
 *    when it advises `owner`. Of several contexts under rules 1 and 2, as
 *    for one object in the containers of two applications, the one that
 *    advises `owner` takes the object; `choose` decides between several.
 * 3. An object that a container created and whose creators are all closed
 *    runs the original function: it belongs to an application that no
 *    longer exists and is not adopted by another one.
 * 4. Any other object, such as one created with `new`, one under
 *    construction, one that a container only holds without advising its
 *    class, or a `this` that is no object, goes to the live contexts that
 *    advise `owner`: the only one, else the one that owns the objects in the
 *    properties of the object, else the one `choose` decides for. Such an
 *    object is resolved again on every call, so it follows the applications
 *    as they start and close.
 *
 * Throws `AspectUsageError` when a strict application is among several that
 * advise the object and nothing tells them apart.
 */
export function resolveContext(
  target: unknown,
  owner: Class,
): DispatchContext | undefined {
  if (isObject(target)) {
    // The common case, without allocation: one owner, known to be current.
    const known = attributions.get(target);
    if (known?.searched === epoch.generation && known.owners.length === 1) {
      const [{ handle, ownership }] = known.owners;
      const only = handle.context;
      if (isLive(only) && (ownership === "created" || only.weaves(owner))) {
        return only;
      }
    }
    const { live, orphaned } = ownersOf(target);
    const taking = live
      .filter(
        ({ context, ownership }) =>
          ownership === "created" || context.weaves(owner),
      )
      .map(({ context }) => context);
    if (taking.length === 1) {
      return taking[0];
    }
    if (taking.length > 1) {
      const advising = taking.filter((context) => context.weaves(owner));
      return advising.length > 1
        ? choose(
            advising,
            owner,
            "the instance that was called is held by the containers of several live applications",
          )
        : (advising[0] ?? taking[0]);
    }
    if (orphaned) {
      return undefined;
    }
  }
  const advising = liveContexts(owner).filter((context) =>
    context.weaves(owner),
  );
  if (advising.length <= 1) {
    return advising[0];
  }
  return (
    (isObject(target) ? ownerOfDependencies(target, advising) : undefined) ??
    choose(
      advising,
      owner,
      "nothing tells which of them the instance that was called belongs to: no container holds it and none created it",
    )
  );
}

/**
 * The delegate that implements the introduced interface `token` for
 * `target` in the application `target` belongs to, or `undefined`. The
 * application is resolved like that of a call, through each class of
 * `target` that carries stubs.
 */
export function resolveIntroduction(
  target: object,
  token: Class,
): object | undefined {
  const type = classOf(target);
  for (const owner of type ? constructorChain(type) : []) {
    const delegate = resolveContext(target, owner)?.introduction(target, token);
    if (delegate) {
      return delegate;
    }
  }
  return undefined;
}
