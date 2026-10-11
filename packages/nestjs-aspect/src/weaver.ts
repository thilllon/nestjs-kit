// The weaver of one Nest application: candidate scan, static matching, stub
// installation, and the completion and validation that run once the
// instances of the container exist.

import "reflect-metadata";
import { type InjectionToken, Logger } from "@nestjs/common";
import {
  ApplicationConfig,
  DiscoveryService,
  ExternalContextCreator,
  HttpAdapterHost,
  LazyModuleLoader,
  MetadataScanner,
  ModuleRef,
  ModulesContainer,
  NestContainer,
  Reflector,
  SerializedGraph,
} from "@nestjs/core";
import {
  createAdviceAdapterRegistry,
  createReturnValueAdapterRegistry,
  promiseAdapter,
} from "./advice";
import { ANNOTATIONS_METADATA, requiredAdviceAnnotations } from "./annotation";
import type {
  AspectModuleOptions,
  AspectReportLevel,
} from "./aspect.module-definition";
import {
  compileAspect,
  describeAdvisor,
  sortAdvisors,
} from "./aspect-compiler";
import {
  getAdviceMetadata,
  getAdvisorPointcut,
  isAdvisor,
  isAspect,
} from "./aspect-decorators";
import { AspectConfigurationError, AspectNotReadyError } from "./errors";
import { createClassRef, createMethodRef } from "./method-ref";
import { isDefaultJoinPoint, matchesStatically } from "./pointcut";
import type {
  AdvisorDescriptor,
  BeanRef,
  Class,
  ClassRef,
  JoinPointKind,
  MethodRef,
  PointcutAdvisor,
} from "./types";
import { constructorChain, isObject } from "./util";
import { type WeavingAdvisor, WeavingContext } from "./weaving-context";
import {
  describeMember,
  describeOrder,
  describeSource,
  reportLine,
} from "./weaving-report";
import { installStub } from "./weaving-stub";

type NestModule = ModulesContainer extends Map<string, infer M> ? M : never;

type InstanceWrapper =
  NestModule["providers"] extends Map<InjectionToken, infer W> ? W : never;

const COLLECTIONS = [
  "providers",
  "controllers",
  "injectables",
  "middlewares",
] as const;

/** One entry of a module's provider, controller, enhancer or middleware map. */
interface Registration {
  readonly module: NestModule;
  readonly collection: (typeof COLLECTIONS)[number];
  readonly token: InjectionToken;
}

/** A class the application can weave, with its container facts. */
interface Candidate {
  readonly type: Class;
  readonly registrations: Registration[];
  readonly beans: BeanRef[];
}

interface Scan {
  /** Weavable classes, in the order the container lists them. */
  readonly candidates: Map<Class, Candidate>;
  /** Registrations of the aspect and `@Advisor` classes, in that order. */
  readonly advisorTypes: Map<Class, Registration[]>;
  /** Classes that are no candidates: aspects, advisors and excluded classes. */
  readonly skipped: Set<Class>;
}

/** An advisor the weaver matches, with the text that names it. */
interface MatchedAdvisor extends WeavingAdvisor {
  readonly label: string;
}

/** Classes of Nest itself; they and their subclasses are never woven. */
const NEST_CLASSES: readonly Class[] = [
  ApplicationConfig,
  DiscoveryService,
  ExternalContextCreator,
  HttpAdapterHost,
  LazyModuleLoader,
  MetadataScanner,
  ModuleRef,
  ModulesContainer,
  NestContainer,
  Reflector,
  SerializedGraph,
];

/** Name of the module in which Nest registers its own providers. */
const NEST_CORE_MODULE = "InternalCoreModule";

const REPORT_LEVELS: readonly unknown[] = ["verbose", "debug", "log"];

const SCOPE_HINT =
  "Aspects and advisors are singletons: per-request state belongs to the join point. Resolve request-scoped providers inside the advice with ModuleRef.resolve() and ContextIdFactory, or read them from a CLS store.";

function isNative(type: Class): boolean {
  return /\{\s*\[native code\]\s*\}$/.test(
    Function.prototype.toString.call(type),
  );
}

function isNestClass(type: Class): boolean {
  return NEST_CLASSES.some(
    (nest) => type === nest || type.prototype instanceof nest,
  );
}

/** True for a class whose prototype can carry stubs. */
function isWeavable(type: unknown): type is Class {
  return (
    typeof type === "function" &&
    isObject(type.prototype) &&
    type.prototype !== Object.prototype &&
    !isNative(type as Class) &&
    !isNestClass(type as Class)
  );
}

function isSingleton(wrapper: InstanceWrapper): boolean {
  return !wrapper.isTransient && wrapper.isDependencyTreeStatic();
}

function inheritanceDepth(type: Class): number {
  return [...constructorChain(type)].length;
}

/**
 * Methods and accessors of a class along its prototype chain, the nearest
 * definition of each name. A getter and a setter are separate members.
 */
function membersOf(type: Class): [string | symbol, JoinPointKind][] {
  const members: [string | symbol, JoinPointKind][] = [];
  const seen = new Set<string | symbol>();
  for (
    let prototype: object | null = type.prototype;
    prototype && prototype !== Object.prototype;
    prototype = Object.getPrototypeOf(prototype)
  ) {
    for (const name of Reflect.ownKeys(prototype)) {
      if (seen.has(name)) {
        continue;
      }
      seen.add(name);
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      if (name === "constructor" || !descriptor) {
        continue;
      }
      if (typeof descriptor.value === "function") {
        members.push([name, "method"]);
      }
      if (typeof descriptor.get === "function") {
        members.push([name, "getter"]);
      }
      if (typeof descriptor.set === "function") {
        members.push([name, "setter"]);
      }
    }
  }
  return members;
}

/** True when the `@Module()` metadata of `importer` lists `imported`. */
function declaresImport(importer: Class, imported: Class): boolean {
  const declared: unknown = Reflect.getMetadata("imports", importer);
  return (
    Array.isArray(declared) &&
    declared.some((entry: unknown) => {
      const resolved =
        isObject(entry) && typeof entry.forwardRef === "function"
          ? (entry.forwardRef() as unknown)
          : entry;
      return (
        resolved === imported ||
        (isObject(resolved) && resolved.module === imported)
      );
    })
  );
}

/**
 * Weaves the aspects and advisors of one application into its classes.
 *
 * `AspectWeaver.weave` is stage 1. It runs in a factory provider, while the
 * container instantiates providers: the module scan is complete, so every
 * class with a metatype is known, and no instance is needed, because aspects
 * compile from class metadata and `@Advisor` classes expose a static
 * pointcut. `complete` is stage 2 and runs in `onModuleInit` of the module.
 */
export class AspectWeaver {
  private readonly logger = new Logger("AspectModule");

  private readonly context: WeavingContext;

  private readonly strict: boolean;

  private readonly reportLevel: AspectReportLevel | false;

  private scan: Scan = {
    candidates: new Map(),
    advisorTypes: new Map(),
    skipped: new Set(),
  };

  private readonly advisors: MatchedAdvisor[] = [];

  /** Resolved singleton instances of aspect and `@Advisor` classes. */
  private readonly instances = new Map<Class, object>();

  private readonly reachable = new Map<Class, Set<Class>>();

  private constructor(
    private readonly container: ModulesContainer,
    private readonly moduleType: Class,
    private readonly options: AspectModuleOptions,
  ) {
    this.strict = options.strict !== false;
    this.reportLevel = options.report ?? "debug";
    if (
      this.reportLevel !== false &&
      !REPORT_LEVELS.includes(this.reportLevel)
    ) {
      throw new AspectConfigurationError(
        'The report option of AspectModule must be "verbose", "debug", "log" or false',
      );
    }
    this.context = new WeavingContext({
      chain: {
        adviceAdapters: createAdviceAdapterRegistry(),
        returnValues: createReturnValueAdapterRegistry([
          ...(options.returnValueAdapters ?? []),
          promiseAdapter,
        ]),
      },
      instancesOf: (type) => this.containerInstances(type),
      warn: (message) => this.logger.warn(message),
    });
  }

  /**
   * Stage 1: compiles the aspects, matches every candidate class against the
   * advisors, installs the stubs and registers the application's context.
   * `moduleType` is the module that owns the weaver; its providers are never
   * woven.
   */
  static weave(
    container: ModulesContainer,
    moduleType: Class,
    options: AspectModuleOptions = {},
  ): AspectWeaver {
    const weaver = new AspectWeaver(container, moduleType, options);
    try {
      weaver.weaveClasses();
    } catch (error) {
      weaver.close();
      throw error;
    }
    return weaver;
  }

  /**
   * Stage 2: weaves the classes that became known since stage 1 (instances of
   * factory and value providers, middleware), validates the configuration and
   * logs the weaving report. In strict mode a validation failure throws
   * `AspectConfigurationError` and closes the context.
   */
  complete(): void {
    try {
      this.weaveLateClasses();
      const problems = [
        ...this.scopeProblems(),
        ...this.misplacedAdviceProblems(),
        ...this.requiredAdviceProblems(),
      ];
      const warnings = [
        ...this.duplicateRegistrationWarnings(),
        ...this.unmatchedPointcutWarnings(),
        ...this.orderTieWarnings(),
      ];
      if (this.strict && problems.length > 0) {
        throw new AspectConfigurationError(problems.join("\n"));
      }
      for (const message of [...problems, ...warnings]) {
        this.logger.warn(message);
      }
      this.logReport();
    } catch (error) {
      this.close();
      throw error;
    }
  }

  /** Unregisters the context; woven members then run their originals. */
  close(): void {
    this.context.close();
  }

  // -------------------------------------------------------------------------
  // Scan
  // -------------------------------------------------------------------------

  private wrapperOf(registration: Registration): InstanceWrapper | undefined {
    const { module, collection, token } = registration;
    return module[collection].get(token);
  }

  /**
   * Lists the classes of the container. With `withInstances`, a factory or
   * value provider contributes the class of its singleton instance.
   */
  private scanContainer(withInstances: boolean): Scan {
    const scan: Scan = {
      candidates: new Map(),
      advisorTypes: new Map(),
      skipped: new Set(),
    };
    const owners = [...this.container.values()].filter(
      (module) => module.metatype === this.moduleType,
    );
    if (owners.length > 1) {
      throw new AspectConfigurationError(
        `${this.moduleType.name} is imported ${owners.length} times with different options; import it once`,
      );
    }
    for (const module of this.container.values()) {
      if (
        module.metatype === this.moduleType ||
        module.metatype.name === NEST_CORE_MODULE
      ) {
        continue;
      }
      for (const collection of COLLECTIONS) {
        for (const [token, wrapper] of module[collection]) {
          const type = this.registeredType(wrapper, withInstances);
          if (!type || type === module.metatype) {
            continue;
          }
          const registration = { module, collection, token };
          if (isAspect(type) || isAdvisor(type)) {
            scan.skipped.add(type);
            const registrations = scan.advisorTypes.get(type) ?? [];
            scan.advisorTypes.set(type, [...registrations, registration]);
            continue;
          }
          let candidate = scan.candidates.get(type);
          if (!candidate) {
            candidate = { type, registrations: [], beans: [] };
            scan.candidates.set(type, candidate);
          }
          candidate.registrations.push(registration);
          candidate.beans.push({ token, module: module.metatype });
        }
      }
    }
    for (const [type, candidate] of scan.candidates) {
      if (this.isExcluded(this.classRefOf(candidate))) {
        scan.candidates.delete(type);
        scan.skipped.add(type);
      }
    }
    return scan;
  }

  private registeredType(
    wrapper: InstanceWrapper,
    withInstances: boolean,
  ): Class | undefined {
    if (!wrapper.isNotMetatype) {
      return isWeavable(wrapper.metatype) ? wrapper.metatype : undefined;
    }
    if (!withInstances || !isSingleton(wrapper)) {
      return undefined;
    }
    const instance: unknown = wrapper.instance;
    if (typeof instance !== "object" || instance === null) {
      return undefined;
    }
    const prototype: unknown = Object.getPrototypeOf(instance);
    const type = isObject(prototype) ? prototype.constructor : undefined;
    return isWeavable(type) && type.prototype === prototype ? type : undefined;
  }

  private classRefOf(candidate: Candidate): ClassRef {
    return createClassRef(candidate.type, {
      beans: candidate.beans,
      reachesModule: (root, imported) => this.reachableFrom(root).has(imported),
    });
  }

  private isExcluded(classRef: ClassRef): boolean {
    return (this.options.exclude ?? []).some((entry) =>
      typeof entry === "function"
        ? classRef.type === entry || classRef.type.prototype instanceof entry
        : entry.matches(classRef),
    );
  }

  /**
   * Module classes within the transitive imports of `root`. Nest adds every
   * global module to the imports of every module, so an edge to a global
   * module counts only when the `@Module()` metadata of the importer lists
   * it.
   */
  private reachableFrom(root: Class): Set<Class> {
    let reached = this.reachable.get(root);
    if (reached) {
      return reached;
    }
    reached = new Set();
    const visited = new Set<NestModule>();
    const pending = [...this.container.values()].filter(
      (module) => module.metatype === root,
    );
    for (let module = pending.pop(); module; module = pending.pop()) {
      if (visited.has(module)) {
        continue;
      }
      visited.add(module);
      for (const imported of module.imports) {
        if (
          imported.isGlobal &&
          !declaresImport(module.metatype, imported.metatype)
        ) {
          continue;
        }
        reached.add(imported.metatype);
        pending.push(imported);
      }
    }
    this.reachable.set(root, reached);
    return reached;
  }

  private *containerInstances(type: Class): Generator<unknown> {
    for (const registration of this.scan.candidates.get(type)?.registrations ??
      []) {
      const wrapper = this.wrapperOf(registration);
      if (!wrapper) {
        continue;
      }
      yield wrapper.instance;
      if (wrapper.isTransient) {
        for (const host of wrapper.getStaticTransientInstances()) {
          yield host?.instance;
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Stage 1
  // -------------------------------------------------------------------------

  private weaveClasses(): void {
    this.scan = this.scanContainer(false);
    let registration = 0;
    for (const type of this.scan.advisorTypes.keys()) {
      this.advisors.push(
        ...(isAspect(type)
          ? this.aspectAdvisors(type, registration)
          : [this.classAdvisor(type, registration)]),
      );
      registration++;
    }
    for (const type of this.scan.skipped) {
      this.context.examine(type);
    }
    // Superclasses first: a subclass then captures the accessor stubs of its
    // superclass like it inherits its method stubs.
    const candidates = [...this.scan.candidates.values()].sort(
      (a, b) => inheritanceDepth(a.type) - inheritanceDepth(b.type),
    );
    for (const candidate of candidates) {
      this.weaveType(candidate);
    }
  }

  private aspectAdvisors(type: Class, registration: number): MatchedAdvisor[] {
    const descriptors = compileAspect(type, {
      resolveAspect: (aspectType) => this.instanceOf(aspectType),
      registration,
    });
    return descriptors.map((descriptor) => ({
      pointcut: descriptor.pointcut,
      type,
      label: `${describeSource(descriptor.source)} (${descriptor.source.kind})`,
      describe: () => descriptor,
    }));
  }

  /**
   * The advisor of an `@Advisor` class: matched by its static pointcut,
   * described from its instance on the first call that needs it.
   */
  private classAdvisor(type: Class, registration: number): MatchedAdvisor {
    const pointcut = getAdvisorPointcut(type);
    let descriptor: AdvisorDescriptor | undefined;
    return {
      pointcut,
      type,
      label: type.name,
      describe: (method) => {
        if (!descriptor) {
          const instance = this.instanceOf(type) as
            | Partial<PointcutAdvisor>
            | undefined;
          if (!instance) {
            throw new AspectNotReadyError(
              `${describeMember(method)} was called before an instance of the advisor ${type.name} exists`,
            );
          }
          descriptor = describeAdvisor(
            {
              pointcut,
              advice: instance.advice as PointcutAdvisor["advice"],
              order: instance.order,
            },
            type,
            registration,
          );
        }
        return descriptor;
      },
    };
  }

  /**
   * The singleton instance of an aspect or `@Advisor` class, once the
   * container has constructed it. Of several registrations of the class, the
   * first one serves.
   */
  private instanceOf(type: Class): object | undefined {
    const resolved = this.instances.get(type);
    if (resolved) {
      return resolved;
    }
    const [registration] = this.scan.advisorTypes.get(type) ?? [];
    const wrapper = registration && this.wrapperOf(registration);
    // The container sets `initTime` when it has constructed the instance;
    // until then the wrapper holds a placeholder object.
    if (!wrapper || wrapper.initTime === undefined || !isSingleton(wrapper)) {
      return undefined;
    }
    const instance: unknown = wrapper.instance;
    if (!isObject(instance)) {
      return undefined;
    }
    this.instances.set(type, instance);
    return instance;
  }

  /**
   * Matches the members of one class against the advisors, installs a stub
   * for each matched member and records it in the context. Weaving a class
   * again replaces what the context recorded for it.
   */
  private weaveType(candidate: Candidate): void {
    const { type } = candidate;
    this.context.examine(type);
    const classRef = this.classRefOf(candidate);
    const applicable = this.advisors.filter((advisor) =>
      advisor.pointcut.classFilter.matches(classRef),
    );
    if (applicable.length === 0) {
      return;
    }
    for (const [name, kind] of membersOf(type)) {
      const method = createMethodRef(classRef, name, kind);
      const matched = applicable.filter((advisor) =>
        matchesStatically(advisor.pointcut, method),
      );
      if (matched.length > 0) {
        installStub(method);
        this.context.setMember(method, matched);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Stage 2
  // -------------------------------------------------------------------------

  private weaveLateClasses(): void {
    const previous = this.scan;
    const scan = this.scanContainer(true);
    // The aspects and advisors are those of stage 1: a class first seen now
    // has no compiled advisors.
    this.scan = { ...scan, advisorTypes: previous.advisorTypes };
    for (const type of scan.skipped) {
      if (!previous.skipped.has(type)) {
        this.context.examine(type);
      }
    }
    const changed = [...scan.candidates.values()]
      .filter(
        (candidate) =>
          candidate.beans.length !==
          previous.candidates.get(candidate.type)?.beans.length,
      )
      .sort((a, b) => inheritanceDepth(a.type) - inheritanceDepth(b.type));
    for (const candidate of changed) {
      this.weaveType(candidate);
    }
  }

  /** An aspect or advisor that is not a singleton, also by scope bubbling. */
  private scopeProblems(): string[] {
    const problems: string[] = [];
    for (const [type, registrations] of this.scan.advisorTypes) {
      const wrapper = this.wrapperOf(registrations[0]);
      if (wrapper && !isSingleton(wrapper)) {
        const role = isAspect(type) ? "aspect" : "advisor";
        problems.push(
          `The ${role} ${type.name} is not a singleton: it is request-scoped or transient, by its own scope or through a dependency. ${SCOPE_HINT}`,
        );
      }
    }
    return problems;
  }

  private misplacedAdviceProblems(): string[] {
    return [...this.scan.candidates.keys(), ...this.scan.skipped]
      .filter((type) => !isAspect(type) && getAdviceMetadata(type).length > 0)
      .map(
        (type) =>
          `${type.name} declares advice (${getAdviceMetadata(type)
            .map((advice) => String(advice.methodName))
            .join(", ")}) but is not decorated with @Aspect`,
      );
  }

  /** Members that carry a `requiresAdvice` annotation and have no advisor. */
  private requiredAdviceProblems(): string[] {
    const unadvised: string[] = [];
    for (const candidate of this.scan.candidates.values()) {
      const advised = new Set(
        [...this.context.membersOf(candidate.type)].map(({ method }) =>
          describeMember(method),
        ),
      );
      const classRef = this.classRefOf(candidate);
      for (const [name, kind] of membersOf(candidate.type)) {
        const method = createMethodRef(classRef, name, kind);
        if (advised.has(describeMember(method))) {
          continue;
        }
        const required = this.requiredAnnotations(method);
        if (required.length > 0) {
          unadvised.push(
            `${describeMember(method)} (${required.map((annotation) => `@${annotation}`).join(", ")})`,
          );
        }
      }
    }
    return unadvised.length === 0
      ? []
      : [
          `No advisor matches these members, whose annotations require advice: ${unadvised.join(", ")}. Register the aspect that handles the annotation as a provider.`,
        ];
  }

  /**
   * `requiresAdvice` annotations of a member. A class annotation applies to
   * the default join points of the class; an accessor or a lifecycle hook is
   * required to be advised only by an annotation it carries itself.
   */
  private requiredAnnotations(method: MethodRef): readonly string[] {
    const required = requiredAdviceAnnotations(method);
    if (required.length === 0 || isDefaultJoinPoint(method)) {
      return required;
    }
    const own: ReadonlyMap<string, unknown> | undefined =
      Reflect.getOwnMetadata(
        ANNOTATIONS_METADATA,
        method.declaringType.prototype,
        method.name,
      );
    return required.filter((annotation) => own?.has(annotation));
  }

  private duplicateRegistrationWarnings(): string[] {
    return [...this.scan.advisorTypes]
      .filter(([, registrations]) => registrations.length > 1)
      .map(
        ([type, registrations]) =>
          `${type.name} is registered ${registrations.length} times; the instance of ${registrations[0].module.metatype.name} serves its advice`,
      );
  }

  private unmatchedPointcutWarnings(): string[] {
    const matched = new Set<WeavingAdvisor>();
    for (const type of this.context.wovenTypes()) {
      for (const member of this.context.membersOf(type)) {
        for (const advisor of member.advisors) {
          matched.add(advisor);
        }
      }
    }
    return this.advisors
      .filter((advisor) => !matched.has(advisor))
      .map(
        (advisor) =>
          `The pointcut of ${advisor.label} matches no member of the application`,
      );
  }

  /**
   * The descriptors of a member's advisors in chain order, without those of
   * an `@Advisor` class that has no instance or an invalid one.
   */
  private describeAdvisors(
    method: MethodRef,
    advisors: readonly WeavingAdvisor[],
  ): AdvisorDescriptor[] {
    const descriptors: AdvisorDescriptor[] = [];
    for (const advisor of advisors) {
      try {
        descriptors.push(advisor.describe(method));
      } catch (error) {
        if (!(error instanceof AspectNotReadyError)) {
          throw error;
        }
      }
    }
    return sortAdvisors(descriptors);
  }

  /** Different aspects or advisors with one order on one join point. */
  private orderTieWarnings(): string[] {
    const warnings = new Map<string, string>();
    for (const type of this.context.wovenTypes()) {
      for (const { method, advisors } of this.context.membersOf(type)) {
        const descriptors = this.describeAdvisors(method, advisors);
        for (const [index, descriptor] of descriptors.entries()) {
          const previous = descriptors[index - 1];
          if (
            !previous ||
            previous.source.type === descriptor.source.type ||
            previous.order !== descriptor.order
          ) {
            continue;
          }
          const pair = `${previous.source.type.name} and ${descriptor.source.type.name}`;
          if (!warnings.has(pair)) {
            warnings.set(
              pair,
              `${pair} advise ${describeMember(method)} with ${describeOrder(descriptor.order)}; ${previous.source.type.name} runs first because it is registered first`,
            );
          }
        }
      }
    }
    return [...warnings.values()];
  }

  private logReport(): void {
    const level = this.reportLevel;
    if (level === false) {
      return;
    }
    for (const type of this.context.wovenTypes()) {
      for (const { method, advisors } of this.context.membersOf(type)) {
        for (const descriptor of this.describeAdvisors(method, advisors)) {
          this.logger[level](reportLine(method, descriptor));
        }
      }
    }
  }
}
