// The weaving state of one Nest application: its woven members and their
// interceptor chains.

import { sortAdvisors } from "./aspect-compiler";
import { AspectConfigurationError, AspectUsageError } from "./errors";
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
import { constructorChain, isObject } from "./util";
import {
  advanceGeneration,
  classOf,
  type DispatchContext,
  liveContexts,
  recordOwner,
  registerType,
} from "./weaving-registry";

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
  /** Why the member cannot be called: it needs advice that nothing supplies. */
  denied?: string;
  /** The introduction whose delegate runs the member instead of a chain. */
  introduction?: Introduction;
  /**
   * Per prototype of a subclass instance: true when the instance inherits
   * the stub from the owner although its own class matched no advisor.
   */
  readonly unadvised: WeakMap<object, boolean>;
}

type MemberKinds = Partial<Record<JoinPointKind, MemberState>>;

/** An interface that an aspect introduces into one class of an application. */
export interface Introduction {
  /** The abstract class that names the interface. */
  readonly token: Class;
  /** The class of the delegates. */
  readonly use: new () => object;
  /** The delegate of each target object, created on first use. */
  readonly delegates: WeakMap<object, object>;
}

export interface WeavingContextOptions {
  readonly chain: ChainOptions;
  /** See `DispatchContext.strict`. */
  readonly strict: boolean;
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

  /** The introductions into each examined class. */
  private readonly introductions = new Map<Class, Introduction[]>();

  constructor(private readonly options: WeavingContextOptions) {}

  get closed(): boolean {
    return this.isClosed;
  }

  get strict(): boolean {
    return this.options.strict;
  }

  /**
   * Records that the weaver examined `type`, which makes this context a
   * candidate for the instances of the class, and drops the members and
   * introductions recorded for it; `setMember` and `introduce` then record
   * those that match.
   */
  examine(type: Class): void {
    this.members.delete(type);
    this.introductions.delete(type);
    advanceGeneration();
    if (this.examined.has(type)) {
      return;
    }
    this.examined.add(type);
    registerType(type, this);
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

  /**
   * Makes every call of a member of an examined class raise
   * `AspectConfigurationError` with `reason`: the member needs advice that
   * no advisor of the application supplies.
   */
  deny(method: MethodRef, reason: string): void {
    const kinds = this.members.get(method.targetType)?.get(method.name);
    if (!kinds?.[method.kind]) {
      this.setMember(method, []);
    }
    const member = this.members.get(method.targetType)?.get(method.name)?.[
      method.kind
    ];
    if (member) {
      member.denied = reason;
    }
  }

  /** Records that the instances of an examined class implement `token`. */
  introduce(type: Class, token: Class, use: new () => object): Introduction {
    const introduction = { token, use, delegates: new WeakMap() };
    this.introductions.set(type, [
      ...(this.introductions.get(type) ?? []),
      introduction,
    ]);
    return introduction;
  }

  /**
   * Records a member that `introduction` adds to an examined class, or with
   * which it replaces a member of the class: the member runs on the delegate
   * of the object it is called on.
   */
  setIntroducedMember(method: MethodRef, introduction: Introduction): void {
    this.setMember(method, []);
    const member = this.members.get(method.targetType)?.get(method.name)?.[
      method.kind
    ];
    if (member) {
      member.introduction = introduction;
    }
  }

  /** Advised members of a class, in the order they were recorded. */
  *membersOf(type: Class): Generator<WovenMember> {
    for (const kinds of this.members.get(type)?.values() ?? []) {
      for (const member of Object.values(kinds)) {
        if (member.advisors.length > 0) {
          yield member;
        }
      }
    }
  }

  /** Classes with at least one woven member. */
  wovenTypes(): Class[] {
    return [...this.members.keys()];
  }

  /**
   * Records that the container of the application created `instance` or
   * handed it out, which makes this context an owner of the object.
   */
  adopt(instance: object): void {
    if (!this.isClosed) {
      recordOwner(instance, this);
    }
  }

  /**
   * Makes the registry search the containers again for the objects it knows:
   * the instances of the container changed.
   */
  refresh(): void {
    advanceGeneration();
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
    return this.members.has(owner) || this.introductions.has(owner);
  }

  /**
   * An instance of a class the application did not examine, such as a
   * subclass outside the container, has the introductions of its nearest
   * examined superclass. An examined class has its own only.
   */
  introduction(target: object, token: Class): object | undefined {
    const type = classOf(target);
    for (const current of type ? constructorChain(type) : []) {
      // The last one: an overriding introduction replaces an earlier one.
      const found = [...(this.introductions.get(current) ?? [])]
        .reverse()
        .find((introduction) => introduction.token === token);
      if (found) {
        return this.delegateOf(target, found);
      }
      if (this.examined.has(current)) {
        break;
      }
    }
    return undefined;
  }

  private delegateOf(target: object, introduction: Introduction): object {
    let delegate = introduction.delegates.get(target);
    if (!delegate) {
      delegate = new introduction.use();
      introduction.delegates.set(target, delegate);
    }
    return delegate;
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
    if (member.denied !== undefined) {
      throw new AspectConfigurationError(member.denied);
    }
    if (member.introduction) {
      return this.runIntroduced(member, member.introduction, target, args);
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

  /** Runs an introduced member on the delegate of `target`. */
  private runIntroduced(
    member: MemberState,
    introduction: Introduction,
    target: object,
    args: readonly unknown[],
  ): unknown {
    const { name, kind, targetType } = member.method;
    if (!isObject(target)) {
      throw new AspectUsageError(
        `${targetType.name}.${String(name)} is introduced by an aspect and was called without its instance`,
      );
    }
    const delegate = this.delegateOf(target, introduction) as Record<
      string | symbol,
      unknown
    >;
    if (kind === "getter") {
      return delegate[name];
    }
    if (kind === "setter") {
      delegate[name] = args[0];
      return undefined;
    }
    return (delegate[name] as Fn).apply(delegate, args as unknown[]);
  }

  reportAmbiguous(owner: Class, message: string): void {
    if (this.reported.has(owner)) {
      return;
    }
    this.reported.add(owner);
    this.options.warn(message);
  }

  /**
   * Detaches the context: its stubs then run the original functions. The
   * instances its container holds are recorded as its own, so no other
   * application adopts them unless its own container holds them too.
   */
  close(): void {
    if (this.isClosed) {
      return;
    }
    for (const type of this.examined) {
      for (const instance of this.options.instancesOf(type)) {
        if (isObject(instance)) {
          this.adopt(instance);
        }
      }
    }
    this.isClosed = true;
    advanceGeneration();
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
    if (!isObject(target)) {
      return false;
    }
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
