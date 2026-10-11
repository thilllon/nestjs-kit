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
import {
  ASPECT_WEAVER,
  ASPECT_WEAVER_GUARD,
  type AspectModuleOptions,
  type AspectReportLevel,
} from "./aspect.module-definition";
import {
  compileAspect,
  describeAdvisor,
  sortAdvisors,
} from "./aspect-compiler";
import {
  getAdviceMetadata,
  getAdvisorPointcut,
  getAspectMetadata,
  isAdvisor,
  isAspect,
} from "./aspect-decorators";
import {
  aspectDependencyProblems,
  createAspectInstance,
} from "./aspect-instantiation";
import {
  AspectConfigurationError,
  AspectNotReadyError,
  AspectUsageError,
} from "./errors";
import {
  getIntroductionMetadata,
  type IntroductionMetadata,
} from "./introduction";
import { createClassRef, createMethodRef } from "./method-ref";
import {
  isDefaultJoinPoint,
  matchesStatically,
  referencedAnnotations,
} from "./pointcut";
import type {
  AdvisorDescriptor,
  BeanRef,
  Class,
  ClassRef,
  JoinPointKind,
  MethodRef,
  PointcutAdvisor,
} from "./types";
import { isObject } from "./util";
import { type WeavingAdvisor, WeavingContext } from "./weaving-context";
import { claimContainer, type Ownership, stubRecord } from "./weaving-registry";
import {
  describeMember,
  describeOrder,
  describeSource,
  reportLine,
} from "./weaving-report";
import { installIntroductionStub, installStub } from "./weaving-stub";

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
  /** Classes of the `exclude` option, with their container facts. */
  readonly excluded: Map<Class, Candidate>;
  /**
   * Classes that are no candidates: aspects, advisors, module classes and
   * excluded classes.
   */
  readonly skipped: Set<Class>;
}

function emptyScan(): Scan {
  return {
    candidates: new Map(),
    advisorTypes: new Map(),
    excluded: new Map(),
    skipped: new Set(),
  };
}

/** An advisor the weaver matches, with the text that names it. */
interface MatchedAdvisor extends WeavingAdvisor {
  readonly label: string;
}

/** An introduction of an aspect, with the text that names it. */
interface DeclaredIntroduction extends IntroductionMetadata {
  /** `"UsageTracking.mixin"`. */
  readonly label: string;
}

/**
 * Classes of Nest itself, which are never woven. A class that extends one of
 * them is a class of the application and is woven like any other.
 */
const NEST_CLASSES: readonly unknown[] = [
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

const IMPORT_HINT =
  "Import AspectModule.forRoot() or forRootAsync() once, in the root module; the module is global.";

const SCOPE_HINT =
  "Aspects and advisors are singletons: per-request state belongs to the join point. Resolve request-scoped providers inside the advice with ModuleRef.resolve() and ContextIdFactory, or read them from a CLS store.";

function isNative(type: Class): boolean {
  return /\{\s*\[native code\]\s*\}$/.test(
    Function.prototype.toString.call(type),
  );
}

/** True for a class whose prototype can carry stubs. */
function isWeavable(type: unknown): type is Class {
  return (
    typeof type === "function" &&
    isObject(type.prototype) &&
    type.prototype !== Object.prototype &&
    !isNative(type as Class) &&
    !NEST_CLASSES.includes(type)
  );
}

/** `"@Retryable, @Cached"`. */
function describeAnnotations(names: readonly string[]): string {
  return names.map((name) => `@${name}`).join(", ");
}

function classNameOf(instance: object): string {
  const prototype: unknown = Object.getPrototypeOf(instance);
  const type = isObject(prototype) ? prototype.constructor : undefined;
  return typeof type === "function" && type.name ? type.name : "an object";
}

function isSingleton(wrapper: InstanceWrapper): boolean {
  return !wrapper.isTransient && wrapper.isDependencyTreeStatic();
}

/** True for a function that is a member of its class in every application. */
function isMember(value: unknown): boolean {
  return typeof value === "function" && !stubRecord(value)?.introduced;
}

/**
 * True when the prototype chain of `type` defines `name` otherwise than as a
 * member that only an introduction adds.
 */
function declaresMember(type: Class, name: string | symbol): boolean {
  for (
    let prototype: object | null = type.prototype;
    prototype && prototype !== Object.prototype;
    prototype = Object.getPrototypeOf(prototype)
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (descriptor) {
      const functions = [descriptor.value, descriptor.get, descriptor.set];
      return (
        functions.every((value) => typeof value !== "function") ||
        functions.some(isMember)
      );
    }
  }
  return false;
}

/**
 * Methods and accessors of a class along its prototype chain, the nearest
 * definition of each name. A getter and a setter are separate members. A
 * member that only an introduction adds is none.
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
      if (isMember(descriptor.value)) {
        members.push([name, "method"]);
      }
      if (isMember(descriptor.get)) {
        members.push([name, "getter"]);
      }
      if (isMember(descriptor.set)) {
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
 * After stage 2, each `LazyModuleLoader.load()` that adds modules weaves and
 * validates their classes.
 */
export class AspectWeaver {
  private readonly logger = new Logger("AspectModule");

  private readonly context: WeavingContext;

  private readonly strict: boolean;

  private readonly reportLevel: AspectReportLevel | false;

  private scan: Scan = emptyScan();

  /**
   * Aspect and `@Advisor` classes that stage 2 finds as the instance of a
   * factory, value or alias provider; they have no compiled advisors.
   */
  private unwovenAdvisorTypes: Class[] = [];

  private readonly advisors: MatchedAdvisor[] = [];

  /** The introductions of the aspects, in registration order. */
  private readonly introductions: DeclaredIntroduction[] = [];

  /** Resolved singleton instances of aspect and `@Advisor` classes. */
  private readonly instances = new Map<Class, object>();

  /**
   * Instances of `perTarget` aspects by target object and of `perClass`
   * aspects by target class. They live as long as their key.
   */
  private readonly keyedInstances = new Map<Class, WeakMap<object, object>>();

  private readonly reachable = new Map<Class, Set<Class>>();

  /** Wrappers whose instance lookups the weaver observes. */
  private readonly observed = new WeakSet<InstanceWrapper>();

  /**
   * The request-scoped and transient factory providers that returned an
   * instance of each class, which was woven when the container first
   * resolved one.
   */
  private readonly scopedRegistrations = new Map<Class, Registration[]>();

  /** True once stage 2 has completed without a failure. */
  private completed = false;

  /** True while the validation that followed the last lazy load failed. */
  private lazyLoadFailed = false;

  /** The validation messages that were logged as warnings. */
  private readonly warned = new Set<string>();

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
        adviceAdapters: createAdviceAdapterRegistry(options.adviceAdapters),
        returnValues: createReturnValueAdapterRegistry([
          ...(options.returnValueAdapters ?? []),
          promiseAdapter,
        ]),
      },
      strict: this.strict,
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
      const existing = claimContainer(container, weaver.context);
      if (existing) {
        existing.close();
        throw new AspectConfigurationError(
          `Two copies of ${moduleType.name} are registered in one application, such as the CommonJS and the ES module build of the package. ${IMPORT_HINT}`,
        );
      }
      weaver.weaveClasses();
    } catch (error) {
      weaver.close();
      throw error;
    }
    return weaver;
  }

  /**
   * Fails when the weaver of a module of type `moduleType` is not a
   * singleton: options that depend on a request-scoped or transient provider
   * make Nest skip the weaver factory and the lifecycle hooks of the module.
   * The dependency tree of a provider is known once the container has
   * instantiated its providers, so this runs in a lifecycle hook.
   */
  static assertSingleton(container: ModulesContainer, moduleType: Class): void {
    for (const module of container.values()) {
      const wrapper =
        module.metatype === moduleType
          ? module.providers.get(ASPECT_WEAVER)
          : undefined;
      if (wrapper && !isSingleton(wrapper)) {
        throw new AspectConfigurationError(
          `The options of ${moduleType.name}.forRootAsync depend on a request-scoped or transient provider, so the weaver does not run and nothing is woven. Supply the options from singleton providers.`,
        );
      }
    }
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
      this.validate(false);
      this.logReport(this.context.wovenTypes());
      this.completed = true;
    } catch (error) {
      this.close();
      throw error;
    }
  }

  /**
   * Weaves the classes of the modules that a call of `LazyModuleLoader.load`
   * added to the container, validates the configuration again and logs the
   * report lines of those classes. `modulesBefore` is the number of modules
   * the container had when the call started. A validation failure throws
   * `AspectConfigurationError` from `load()`; the application stays live,
   * and a later `load()` reports the failure again.
   */
  private completeLazyModules(modulesBefore: number): void {
    if (
      this.context.closed ||
      !this.completed ||
      (this.container.size === modulesBefore && !this.lazyLoadFailed)
    ) {
      return;
    }
    this.lazyLoadFailed = true;
    const woven = this.weaveLateClasses();
    this.validate(true);
    this.logReport(woven);
    this.lazyLoadFailed = false;
  }

  /**
   * Throws `AspectConfigurationError` for the findings that fail the
   * application and logs the other ones, each message once. `lazy` tells
   * that the weaving followed the load of a lazy module.
   */
  private validate(lazy: boolean): void {
    // Advice that can never run fails in every mode: no call could report
    // it.
    const fatal = [
      ...this.unwovenAdvisorProblems(lazy),
      ...this.misplacedAdviceProblems(),
    ];
    // Without strict mode these are warnings, and the calls they concern
    // raise an error instead of running without advice.
    const problems = [
      ...this.scopeProblems(),
      ...this.aspectDependencyProblems(),
      ...this.invalidAdvisorProblems(),
      ...this.requiredAdviceProblems(),
    ];
    const warnings = [
      ...this.duplicateRegistrationWarnings(),
      ...this.unmatchedPointcutWarnings(),
      ...this.orderTieWarnings(),
      ...this.shutdownOrderWarnings(),
    ];
    if (fatal.length > 0 || (this.strict && problems.length > 0)) {
      throw new AspectConfigurationError([...fatal, ...problems].join("\n"));
    }
    for (const message of [...problems, ...warnings]) {
      if (!this.warned.has(message)) {
        this.warned.add(message);
        this.logger.warn(message);
      }
    }
  }

  /** Unregisters the context; woven members then run their originals. */
  close(): void {
    this.context.close();
  }

  /**
   * The woven members, each with the descriptors of its advisors in chain
   * order; nothing once the weaver is closed. Read by `AspectInspector`.
   */
  *advisedMembers(): Generator<{
    readonly method: MethodRef;
    readonly advisors: readonly AdvisorDescriptor[];
  }> {
    if (this.context.closed) {
      return;
    }
    for (const type of this.context.wovenTypes()) {
      for (const { method, advisors } of this.context.membersOf(type)) {
        yield { method, advisors: this.describeAdvisors(method, advisors) };
      }
    }
  }

  // -------------------------------------------------------------------------
  // Scan
  // -------------------------------------------------------------------------

  private wrapperOf(registration: Registration): InstanceWrapper | undefined {
    const { module, collection, token } = registration;
    return module[collection].get(token);
  }

  /**
   * True for the module in which Nest registers its own providers. The name
   * alone does not identify it: a module of the application can carry the
   * same name. Only the core module supplies the `ModulesContainer` the
   * weaver was created with.
   */
  private isNestCoreModule(module: NestModule): boolean {
    return (
      module.metatype.name === NEST_CORE_MODULE &&
      module.providers.get(ModulesContainer)?.instance === this.container
    );
  }

  /**
   * True for the providers of the weaver itself. Other providers of its
   * module, such as an options factory class, are woven.
   */
  private isOwnProvider(module: NestModule, token: InjectionToken): boolean {
    return (
      module.metatype === this.moduleType &&
      (token === ASPECT_WEAVER || token === ASPECT_WEAVER_GUARD)
    );
  }

  /**
   * Observes the instance lookups of every wrapper of the container, so the
   * context learns which instances the application creates and hands out:
   * the instances of request-scoped, transient and durable providers exist
   * in no enumerable collection of the container.
   */
  private observeInstances(): void {
    for (const module of this.container.values()) {
      if (this.isNestCoreModule(module)) {
        continue;
      }
      for (const collection of COLLECTIONS) {
        for (const [token, wrapper] of module[collection]) {
          if (this.observed.has(wrapper) || this.isOwnProvider(module, token)) {
            continue;
          }
          this.observed.add(wrapper);
          const registration = { module, collection, token };
          const lookup = wrapper.getInstanceByContextId;
          const observe = (host: {
            instance?: unknown;
            isResolved?: boolean;
          }) => this.observe(registration, wrapper, host);
          wrapper.getInstanceByContextId = function (contextId, inquirerId) {
            const host = lookup.call(this, contextId, inquirerId);
            observe(host);
            return host;
          };
        }
      }
    }
  }

  /**
   * Makes the `LazyModuleLoader` of the application weave the classes of
   * each module it has loaded: `load()` resolves when they are woven.
   */
  private observeLazyModules(): void {
    for (const module of this.container.values()) {
      const loader: unknown = this.isNestCoreModule(module)
        ? module.providers.get(LazyModuleLoader)?.instance
        : undefined;
      if (!isObject(loader) || typeof loader.load !== "function") {
        continue;
      }
      const load = loader.load as LazyModuleLoader["load"];
      const container = this.container;
      const complete = (modulesBefore: number) =>
        this.completeLazyModules(modulesBefore);
      loader.load = async function (
        this: LazyModuleLoader,
        ...args: Parameters<LazyModuleLoader["load"]>
      ) {
        const modulesBefore = container.size;
        const moduleRef = await load.apply(this, args);
        complete(modulesBefore);
        return moduleRef;
      };
    }
  }

  private observe(
    registration: Registration,
    wrapper: InstanceWrapper,
    host: { instance?: unknown; isResolved?: boolean } | undefined,
  ): void {
    const instance = host?.instance;
    if (this.context.closed || !host?.isResolved || !isObject(instance)) {
      return;
    }
    this.context.adopt(instance, wrapper.isNotMetatype ? "held" : "created");
    if (wrapper.isNotMetatype && !isSingleton(wrapper)) {
      this.weaveScopedInstance(registration, instance);
    }
  }

  /**
   * Weaves the class of an instance that a request-scoped or transient
   * factory provider returned, when the container resolves the first one of
   * that class for the provider. A class that is a candidate already is
   * woven again with the token of the provider among its beans.
   * Throws `AspectConfigurationError` for an aspect or advisor: its advice
   * would never run.
   */
  private weaveScopedInstance(registration: Registration, instance: object) {
    const prototype: unknown = Object.getPrototypeOf(instance);
    const type = isObject(prototype) ? prototype.constructor : undefined;
    if (
      !isWeavable(type) ||
      type.prototype !== prototype ||
      this.scan.excluded.has(type) ||
      this.scan.advisorTypes.has(type)
    ) {
      return;
    }
    const known = this.scopedRegistrations.get(type) ?? [];
    if (
      known.some(
        (other) =>
          other.module === registration.module &&
          other.collection === registration.collection &&
          other.token === registration.token,
      )
    ) {
      return;
    }
    if (isAspect(type) || isAdvisor(type)) {
      throw new AspectConfigurationError(this.unwovenAdvisorProblem(type));
    }
    const candidate = this.withScoped({
      type,
      registrations: [
        ...(this.scan.candidates.get(type)?.registrations ?? []),
        registration,
      ],
      beans: [],
    });
    if (this.isExcluded(this.classRefOf(candidate))) {
      this.context.exclude(type);
      this.denyUnadvised(type);
    } else {
      this.weaveType(candidate);
    }
    // Recorded once the class is woven: a failure repeats for every
    // instance instead of leaving the later ones without advice.
    this.scopedRegistrations.set(type, [...known, registration]);
  }

  /**
   * `candidate` with the registrations of the request-scoped and transient
   * factory providers that returned an instance of its class.
   */
  private withScoped(candidate: Candidate): Candidate {
    const registrations = [
      ...candidate.registrations,
      ...(this.scopedRegistrations.get(candidate.type) ?? []),
    ];
    return {
      type: candidate.type,
      registrations,
      beans: registrations.map(({ token, module }) => ({
        token,
        module: module.metatype,
      })),
    };
  }

  /**
   * Lists the classes of the container. With `withInstances`, a factory or
   * value provider contributes the class of its singleton instance.
   */
  private scanContainer(withInstances: boolean): Scan {
    const scan = emptyScan();
    const owners = [...this.container.values()].filter(
      (module) => module.metatype === this.moduleType,
    );
    if (owners.length > 1) {
      throw new AspectConfigurationError(
        `${this.moduleType.name} is registered ${owners.length} times. ${IMPORT_HINT}`,
      );
    }
    for (const module of this.container.values()) {
      if (this.isNestCoreModule(module)) {
        continue;
      }
      for (const collection of COLLECTIONS) {
        for (const [token, wrapper] of module[collection]) {
          const type = this.isOwnProvider(module, token)
            ? undefined
            : this.registeredType(wrapper, withInstances);
          if (!type) {
            continue;
          }
          if (type === module.metatype) {
            scan.skipped.add(type);
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
        scan.excluded.set(type, candidate);
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

  private *containerInstances(
    type: Class,
  ): Generator<readonly [unknown, Ownership]> {
    const { candidates, excluded, advisorTypes } = this.scan;
    const registrations =
      (candidates.get(type) ?? excluded.get(type))?.registrations ??
      advisorTypes.get(type) ??
      [];
    for (const registration of registrations) {
      const wrapper = this.wrapperOf(registration);
      if (!wrapper) {
        continue;
      }
      const ownership = wrapper.isNotMetatype ? "held" : "created";
      yield [wrapper.instance, ownership];
      if (wrapper.isTransient) {
        for (const host of wrapper.getStaticTransientInstances()) {
          yield [host?.instance, ownership];
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Stage 1
  // -------------------------------------------------------------------------

  private weaveClasses(): void {
    this.scan = this.scanContainer(false);
    this.observeInstances();
    this.observeLazyModules();
    let registration = 0;
    for (const type of this.scan.advisorTypes.keys()) {
      this.advisors.push(
        ...(isAspect(type)
          ? this.aspectAdvisors(type, registration)
          : [this.classAdvisor(type, registration)]),
      );
      if (isAspect(type)) {
        this.introductions.push(
          ...getIntroductionMetadata(type).map((introduction) => ({
            ...introduction,
            label: `${type.name}.${String(introduction.memberName)}`,
          })),
        );
      }
      registration++;
    }
    this.examineSkipped(this.scan);
    for (const candidate of this.scan.candidates.values()) {
      this.weaveType(candidate);
    }
  }

  /**
   * Makes the context a candidate for the instances of unwoven classes, and
   * denies the calls of their members that require advice.
   */
  private examineSkipped(scan: Scan): void {
    for (const type of scan.skipped) {
      if (scan.excluded.has(type)) {
        this.context.exclude(type);
      } else {
        this.context.examine(type);
      }
      this.denyUnadvised(type);
    }
  }

  /**
   * Installs a stub that rejects every call of the members of a class that
   * is never advised and that carry a `requiresAdvice` annotation.
   */
  private denyUnadvised(type: Class): void {
    const classRef = createClassRef(type);
    for (const [name, kind] of membersOf(type)) {
      const method = createMethodRef(classRef, name, kind);
      const required = this.requiredAnnotations(method);
      if (required.length > 0) {
        installStub(method);
        this.context.requireAdvice(method);
        this.context.deny(
          method,
          `${describeMember(method)} carries ${describeAnnotations(required)}, which requires advice, and ${type.name} is never advised: it is an aspect, an advisor, a module class or a class of the exclude option`,
        );
      }
    }
  }

  /**
   * The `requiresAdvice` annotations of a member that none of `advisors`
   * handles. An advisor handles an annotation when its pointcut refers to
   * it, or when the pointcut has a caller-supplied matcher.
   */
  private unhandledAnnotations(
    method: MethodRef,
    advisors: readonly WeavingAdvisor[],
  ): readonly string[] {
    const required = this.requiredAnnotations(method);
    if (required.length === 0) {
      return required;
    }
    const references = advisors.map((advisor) =>
      referencedAnnotations(advisor.pointcut),
    );
    return required.filter(
      (annotation) =>
        !references.some((names) => !names || names.has(annotation)),
    );
  }

  private aspectAdvisors(type: Class, registration: number): MatchedAdvisor[] {
    const descriptors = compileAspect(type, {
      resolveAspect: (aspectType, method, target) =>
        this.aspectInstance(aspectType, method, target),
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
   * The aspect instance that serves a call: the provider instance of a
   * singleton aspect, or the instance of a `perTarget` or `perClass` aspect
   * that belongs to the target object or to the class of the join point.
   * Such an instance is created on the first call that needs it, once the
   * container has constructed the provider instance of the aspect, which
   * shows that its dependencies exist.
   */
  private aspectInstance(
    type: Class,
    method: MethodRef,
    target: object,
  ): object | undefined {
    const model = getAspectMetadata(type)?.instantiation ?? "singleton";
    if (model === "singleton") {
      return this.instanceOf(type);
    }
    if (!isObject(target)) {
      throw new AspectUsageError(
        `${describeMember(method)} was called without its instance, which the ${model} aspect ${type.name} needs`,
      );
    }
    const key: object = model === "perTarget" ? target : method.targetType;
    let instances = this.keyedInstances.get(type);
    if (!instances) {
      instances = new WeakMap();
      this.keyedInstances.set(type, instances);
    }
    let instance = instances.get(key);
    if (!instance) {
      const moduleRef = this.moduleRefOf(type);
      if (!this.instanceOf(type) || !moduleRef) {
        return undefined;
      }
      instance = createAspectInstance(type, model, moduleRef);
      instances.set(key, instance);
    }
    return instance;
  }

  /** The `ModuleRef` of the module that registers an aspect class first. */
  private moduleRefOf(type: Class): ModuleRef | undefined {
    const [registration] = this.scan.advisorTypes.get(type) ?? [];
    const instance: unknown =
      registration?.module.providers.get(ModuleRef)?.instance;
    return instance instanceof ModuleRef ? instance : undefined;
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
    for (const [name, kind] of membersOf(type)) {
      const method = createMethodRef(classRef, name, kind);
      const matched = applicable.filter((advisor) =>
        matchesStatically(advisor.pointcut, method),
      );
      if (matched.length > 0) {
        installStub(method);
        this.context.setMember(method, matched);
        if (this.requiredAnnotations(method).length > 0) {
          this.context.requireAdvice(method);
        }
      }
      // A member that requires advice no advisor supplies cannot be called:
      // the validation of stage 2 reports it, and an application that is
      // not strict, or that is never initialized, must not run it unadvised.
      const unhandled = this.unhandledAnnotations(method, matched);
      if (unhandled.length > 0) {
        installStub(method);
        this.context.requireAdvice(method);
        this.context.deny(
          method,
          `${describeMember(method)} carries ${describeAnnotations(unhandled)}, which requires advice, and no advisor of the application handles it`,
        );
      }
    }
    this.introduceInto(type, classRef);
  }

  /**
   * Applies the introductions whose class filter matches a class: each
   * method and accessor of the delegate class becomes a member of the class.
   * A member of an introduction replaces the advice of the member it
   * overrides.
   *
   * Throws `AspectConfigurationError` when the class or another introduction
   * already has a member of that name and the introduction does not set
   * `override`.
   */
  private introduceInto(type: Class, classRef: ClassRef): void {
    const added = new Map<string | symbol, string>();
    for (const declared of this.introductions) {
      const { classFilter, token, use, override, label } = declared;
      if (!classFilter.matches(classRef)) {
        continue;
      }
      const members = membersOf(use);
      for (const [name] of override ? [] : members) {
        const other = added.get(name);
        if (other !== undefined && other !== label) {
          throw new AspectConfigurationError(
            `The introduction ${label} adds ${String(name)} to ${type.name}, which the introduction ${other} adds as well; set override: true to replace it`,
          );
        }
        if (other === undefined && declaresMember(type, name)) {
          throw new AspectConfigurationError(
            `The introduction ${label} adds ${String(name)} to ${type.name}, which already has a member of that name; set override: true to replace it`,
          );
        }
      }
      const introduction = this.context.introduce(type, token, use);
      for (const [name, kind] of members) {
        added.set(name, label);
        const original = installIntroductionStub(type, name, kind);
        this.context.setIntroducedMember(
          {
            declaringType: use,
            targetType: type,
            classRef,
            name,
            kind,
            original,
            isAsync: false,
          },
          introduction,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Stage 2
  // -------------------------------------------------------------------------

  /** Returns the classes it wove. */
  private weaveLateClasses(): Class[] {
    const previous = this.scan;
    const scan = this.scanContainer(true);
    this.observeInstances();
    // The aspects and advisors are those of stage 1: a class first seen now
    // has no compiled advisors.
    this.scan = { ...scan, advisorTypes: previous.advisorTypes };
    this.unwovenAdvisorTypes = [...scan.advisorTypes.keys()].filter(
      (type) => !previous.advisorTypes.has(type),
    );
    this.examineSkipped({
      ...scan,
      skipped: new Set(
        [...scan.skipped].filter((type) => !previous.skipped.has(type)),
      ),
    });
    const changed = [...scan.candidates.values()].filter(
      (candidate) =>
        candidate.beans.length !==
        previous.candidates.get(candidate.type)?.beans.length,
    );
    for (const candidate of changed) {
      this.weaveType(this.withScoped(candidate));
    }
    this.context.refresh();
    // From here on the instances keep the application live by themselves.
    this.context.adoptInstances();
    return changed.map((candidate) => candidate.type);
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

  /**
   * Dependencies of `perTarget` and `perClass` aspects that are no singleton
   * providers.
   */
  private aspectDependencyProblems(): string[] {
    const problems: string[] = [];
    for (const type of this.scan.advisorTypes.keys()) {
      const model = getAspectMetadata(type)?.instantiation ?? "singleton";
      const moduleRef = this.moduleRefOf(type);
      if (model !== "singleton" && moduleRef) {
        problems.push(...aspectDependencyProblems(type, model, moduleRef));
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

  /**
   * An aspect or advisor class that reaches the container only as the
   * instance of a factory, value or alias provider.
   */
  private unwovenAdvisorProblems(lazy: boolean): string[] {
    return this.unwovenAdvisorTypes.map((type) =>
      lazy
        ? `The ${isAspect(type) ? "aspect" : "advisor"} ${type.name} is registered by a lazy-loaded module, so its advice does not run. Register aspects and advisors in a module that the application loads when it bootstraps.`
        : this.unwovenAdvisorProblem(type),
    );
  }

  private unwovenAdvisorProblem(type: Class): string {
    const role = isAspect(type) ? "aspect" : "advisor";
    return `The ${role} ${type.name} is the instance of a factory, value or alias provider, so its advice does not run. Register the class as a provider, by itself or with useClass.`;
  }

  /**
   * Members that carry a `requiresAdvice` annotation which none of their
   * advisors handles, and such members of aspects, advisors, module classes
   * and excluded classes, which are never advised.
   */
  private requiredAdviceProblems(): string[] {
    const unadvised: string[] = [];
    const describe = (method: MethodRef, required: readonly string[]) =>
      `${describeMember(method)} (${describeAnnotations(required)})`;
    for (const candidate of this.scan.candidates.values()) {
      const advisors = new Map(
        [...this.context.membersOf(candidate.type)].map((member) => [
          describeMember(member.method),
          member.advisors,
        ]),
      );
      const classRef = this.classRefOf(this.withScoped(candidate));
      for (const [name, kind] of membersOf(candidate.type)) {
        const method = createMethodRef(classRef, name, kind);
        const required = this.unhandledAnnotations(
          method,
          advisors.get(describeMember(method)) ?? [],
        );
        if (required.length > 0) {
          unadvised.push(describe(method, required));
        }
      }
    }
    const neverAdvised: string[] = [];
    for (const type of this.scan.skipped) {
      const classRef = createClassRef(type);
      for (const [name, kind] of membersOf(type)) {
        const method = createMethodRef(classRef, name, kind);
        const required = this.requiredAnnotations(method);
        if (required.length > 0) {
          neverAdvised.push(describe(method, required));
        }
      }
    }
    return [
      ...(unadvised.length === 0
        ? []
        : [
            `No advisor handles the annotations that require advice on these members: ${unadvised.join(", ")}. Register the aspect that handles the annotation as a provider; its pointcut refers to the annotation with P.annotated, P.withinAnnotated or P.targetAnnotated.`,
          ]),
      ...(neverAdvised.length === 0
        ? []
        : [
            `These members carry annotations that require advice, and aspects, advisors, module classes and the classes of the exclude option are never advised: ${neverAdvised.join(", ")}.`,
          ]),
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
        if (
          !(error instanceof AspectNotReadyError) &&
          !(error instanceof AspectConfigurationError)
        ) {
          throw error;
        }
      }
    }
    return sortAdvisors(descriptors);
  }

  /**
   * `@Advisor` instances without advice or with an order that is no number,
   * among the advisors that matched a member.
   */
  private invalidAdvisorProblems(): string[] {
    const problems = new Set<string>();
    for (const type of this.context.wovenTypes()) {
      for (const { method, advisors } of this.context.membersOf(type)) {
        for (const advisor of advisors) {
          try {
            advisor.describe(method);
          } catch (error) {
            if (error instanceof AspectConfigurationError) {
              problems.add(error.message);
            } else if (!(error instanceof AspectNotReadyError)) {
              throw error;
            }
          }
        }
      }
    }
    return [...problems];
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

  /**
   * Global modules registered before the module of the weaver whose
   * instances have an `onApplicationShutdown` hook. Nest runs the shutdown
   * hooks of global modules in reverse registration order, so those hooks
   * run after the weaver has closed the context.
   */
  private shutdownOrderWarnings(): string[] {
    const warnings: string[] = [];
    for (const module of this.container.values()) {
      if (module.metatype === this.moduleType) {
        break;
      }
      if (!module.isGlobal || this.isNestCoreModule(module)) {
        continue;
      }
      const hooked = new Set<string>();
      for (const collection of COLLECTIONS) {
        for (const wrapper of module[collection].values()) {
          const instance: unknown = isSingleton(wrapper)
            ? wrapper.instance
            : undefined;
          if (
            isObject(instance) &&
            typeof instance.onApplicationShutdown === "function"
          ) {
            hooked.add(classNameOf(instance));
          }
        }
      }
      if (hooked.size > 0) {
        warnings.push(
          `The global module ${module.metatype.name} is imported before ${this.moduleType.name}, so the onApplicationShutdown hook of ${[...hooked].join(", ")} runs after ${this.moduleType.name} has shut down and the calls it makes are not advised. Import ${this.moduleType.name} first.`,
        );
      }
    }
    return warnings;
  }

  /** Logs the report lines of the advised members of `types`. */
  private logReport(types: readonly Class[]): void {
    const level = this.reportLevel;
    if (level === false) {
      return;
    }
    for (const type of types) {
      for (const { method, advisors } of this.context.membersOf(type)) {
        for (const descriptor of this.describeAdvisors(method, advisors)) {
          this.logger[level](reportLine(method, descriptor));
        }
      }
    }
  }
}
