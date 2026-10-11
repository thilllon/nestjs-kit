# NestJS AOP - Design

Related documents:

- [`spring-aop-analysis.md`](./spring-aop-analysis.md) - the Spring AOP model this design maps to
  (feature list F1-F27 in §12 of that document).
- [`sketch/api.ts`](./sketch/api.ts) - a type-level sketch of the public API.
  `tsc --project docs/sketch` passes, and every `@ts-expect-error` in it is a misuse that the API
  rejects at compile time.
- [`spike/`](./spike) - runnable spikes on NestJS 12.1.2 that back the weaving decision in
  §3.

---

## 1. Goals and non-goals

**Goals**

1. Implement the Spring AOP model on top of NestJS: aspects as providers, pointcuts independent of
   the class hierarchy, the five advice kinds with exactly the same semantics as Spring, ordering,
   introductions, instantiation models, and the low-level Advisor API.
2. Type safety from end to end: pointcut → advice signature → decorated method signature.
3. Correct for asynchronous code by default (Promise), and extensible to other asynchronous types (Observable).
4. Works on every class Nest manages: providers, controllers, gateways, enhancers,
   request/transient scopes.
5. Deterministic behavior: a defined weaving time, a defined order, and bootstrap-time errors
   instead of silent no-ops.

**Non-goals (v1)**

- Join points other than method/accessor execution (constructors, field access, calls).
- Advising objects that the Nest container did not create (AspectJ `@Configurable`).
- A string pointcut expression language as the primary API (see §4.3.4).
- Changing the advice chain of a live object (`Advised.addAdvisor`).

---

## 2. Platform constraints (TypeScript / Node / Nest versus Java / Spring)

| #   | Constraint                                                                                                                                                                                                                     | Consequence                                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | There are no runtime types. `design:paramtypes` / `design:returntype` exist only on members that carry _some_ decorator, and only when `emitDecoratorMetadata` is on.                                                          | Return/parameter type matching in the style of `execution(String *(..))` is impossible. Type information lives in TypeScript types, so the pointcut must carry it statically.                   |
| C2  | Nest uses legacy `experimentalDecorators` (parameter decorators require it).                                                                                                                                                   | The API is built on legacy method/class decorators. `TypedPropertyDescriptor<T>` lets a decorator constrain the type of the method it decorates.                                                |
| C3  | There are no packages.                                                                                                                                                                                                         | The natural "package" in Nest is the **module**: `within(com.xyz.service..*)` ↔ `P.inModule(ServiceModule, { transitive: true })`.                                                              |
| C4  | Asynchrony is everywhere (Promise, and Observable in controllers/RxJS).                                                                                                                                                        | Advice must follow settlement, not the synchronous return. Spring's general-purpose advice does not (analysis §11.7), and copying it as is makes `@AfterThrowing` useless in asynchronous code. |
| C5  | There is no `BeanPostProcessor`, and no hook between "instance creation finished" and "the framework captures the handler".                                                                                                    | The weaving time must be chosen carefully (§3).                                                                                                                                                 |
| C6  | The Nest router captures `prototype[methodName]` in `registerRouter()`, and `init()` runs it **before** `callInitHook()` (verified in `nest-application.js` `init()` and `router/paths-explorer.js` of `@nestjs/core` 12.1.2). | Swapping methods in `onModuleInit` is too late for controllers.                                                                                                                                 |
| C7  | `onModuleInit` runs per module, sorted by distance (deepest first, global modules first).                                                                                                                                      | Weaving in the `onModuleInit` of a non-global module leaves earlier hooks unadvised. Reproduced with `@toss/nestjs-aop@2.2.1` (`spike/nestjs-aop-lifecycle.ts`).                                |
| C8  | Several Nest applications can exist in one process (tests). Class prototypes are process-global.                                                                                                                               | The advice chain must be per application, not per prototype.                                                                                                                                    |
| C9  | Arrow-function class fields are per-instance own properties, and `#private` methods are inaccessible.                                                                                                                          | Neither can be a join point (prototype-based weaving). This is the same class of constraint as Spring's `final`/`private`.                                                                      |
| C10 | `Reflect.getMetadata` walks the `[[Prototype]]` chain of the target object.                                                                                                                                                    | Applying `Object.setPrototypeOf(stub, original)` to the replacement function keeps all metadata (Swagger, route metadata) visible without copying.                                              |

---

## 3. Weaving strategy

### 3.1 Options

|                                                                    | A. In-place prototype weaving during instantiation (**recommended**)                                                                                                                                                                                                                                                                                                                       | B. Proxy substitution in the container                                      | C. Decoration-time stubs only                                                                                                                                                             |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mechanism                                                          | A provider in a `@Global()` module receives `ModulesContainer` in its factory. Scanning is finished at that point, so it walks the `metatype` of every wrapper, evaluates static pointcuts against **aspect class metadata** (no aspect instance required), and replaces matched methods on the class prototype with a dispatcher stub. Advice instances are resolved lazily at call time. | Replace each advised provider instance with an ES `Proxy` (Spring's model). | The AOP decorator on the target method replaces the descriptor with a dispatcher at class definition time, and aspects are connected at bootstrap time (the `@toss/nestjs-aop` approach). |
| Pointcuts not tied to a target annotation (`within`, name, module) | Yes                                                                                                                                                                                                                                                                                                                                                                                        | Yes                                                                         | **No** - every target needs an annotation                                                                                                                                                 |
| Controllers / gateways (C6)                                        | Yes (woven before `registerRouter`)                                                                                                                                                                                                                                                                                                                                                        | **No** - the router binds the original instance and the prototype function  | Yes                                                                                                                                                                                       |
| Order relative to lifecycle hooks (C7)                             | Woven before every `onModuleInit`                                                                                                                                                                                                                                                                                                                                                          | Depends on the substitution point                                           | Depends on when aspects are connected                                                                                                                                                     |
| Self-invocation (`this.bar()`)                                     | **Advised** (AspectJ semantics)                                                                                                                                                                                                                                                                                                                                                            | Not advised (Spring semantics)                                              | Advised                                                                                                                                                                                   |
| `instanceof`, identity, `this === target`                          | Unchanged                                                                                                                                                                                                                                                                                                                                                                                  | Proxy identity problems, `this` ≠ proxy inside methods                      | Unchanged                                                                                                                                                                                 |
| Implementation risk                                                | Uses `ModulesContainer`, a public API, and one factory provider                                                                                                                                                                                                                                                                                                                            | Providers must be rewritten before injection and no supported hook exists   | Low, but features are limited                                                                                                                                                             |

Option B cannot be implemented without patching Nest internals: dependents receive their
dependencies in the same instantiation phase, and the router calls the prototype function with the
original instance. Option C cannot express Spring's core feature (non-invasive pointcuts).

### 3.2 Evidence (spikes, NestJS 12.1.2)

The spikes in `spike/` form a standalone project outside the pnpm workspace and outside every
repository check. Run them from `docs/spike` with `pnpm install --ignore-workspace`, `pnpm build`,
and then `pnpm weaving`, `pnpm testing` or `pnpm nestjs-aop`.

`spike/weaving-timing.ts` implements option A in about 30 lines and prints the following:

```
{"body":{"user":{"id":1},"scoped":"scoped"},"meta":"kept"}   ← route + SetMetadata preserved
woven
deep onModuleInit                    ← non-global, deepest module: already advised
before UserService.load
afterReturning UserService.load
before UserController.get            ← HTTP route handler is advised (stub captured)
before UserService.find
before UserService.load              ← self-invocation is advised
afterReturning UserService.load
afterReturning UserService.find
before ScopedThing.hello             ← REQUEST-scoped provider is advised
...
afterReturning UserService.findAsync ← async: after settlement
--- after close                      ← new UserService() after app.close(): not advised
```

`spike/testing-compile.ts` confirms that the weaver factory has already run after
`Test.createTestingModule(...).compile()` without `init()`.

`spike/nestjs-aop-lifecycle.ts` against `@toss/nestjs-aop@2.2.1`:

```
run from deep onModuleInit           ← decorated method ran without advice
advised run
run from after init
```

### 3.3 Weaving pipeline

```
NestFactory.create / Test.createTestingModule().compile()
 └─ DependenciesScanner.scan()                 modules, wrappers and metatypes are final
 └─ InstanceLoader.createInstancesOfDependencies()
     └─ AOP_WEAVER factory (inside the @Global AopModule)   ◄── phase 1
          1. Collect aspects/advisors: wrappers whose metatype has @Aspect / @AopAdvisor
          2. Compile aspects → Advisor[] (pointcut + advice descriptor + order)
          3. For each candidate class (providers, controllers, injectables, middleware;
             excluding aspects, advisors, Nest core and this module):
               for each method/accessor on the prototype chain:
                 static advisor matching (ClassFilter, then MethodMatcher)
                 if 1 or more match: install dispatcher stub, register (class, key) → advisors
          4. Register the AopContext of this application
 └─ (other providers are instantiated)
 └─ app.init(): registerRouter → captures stubs; callInitHook → already advised
 └─ AopModule.onModuleInit                                 ◄── phase 2
          - resolve aspect instances; validate scopes (§5.6)
          - weave factory/value provider instances (metatype unknown in phase 1)
          - validate `requiresAdvice` annotations and introductions; print the weaving report
 └─ AopModule.onApplicationShutdown → unregister the AopContext
```

Guarantee: **advice is active from the first lifecycle hook and at every framework entry point**.
Calls made inside a constructor are not guaranteed to be advised (Spring has the same caveat: the
proxy is created after initialization). A call that reaches a stub before its owning aspect is
instantiated throws `AopNotReadyError` instead of silently skipping the advice.

### 3.4 Dispatcher stub

```ts
function installStub(proto, key, original, kind /* method | get | set */) {
  const stub = function (this: object, ...args: unknown[]) {
    const ctx = resolveContext(this, proto.constructor); // §5.5
    if (!ctx) return original.apply(this, args); // unmanaged object / closed app
    return ctx.invoke(this, joinPointStatic, original, args); // chain cached per (class, key)
  };
  Object.defineProperty(stub, "name", { value: original.name });
  Object.defineProperty(stub, "length", { value: original.length });
  Object.setPrototypeOf(stub, original); // C10: metadata stays visible
  stub[ORIGINAL] = original; // unwrap when weaving subclasses / re-weaving
  defineOnPrototype(proto, key, stub, kind);
}
```

- One stub per (class, key), regardless of the number of matching advisors.
- Classes with no matching advisor are left untouched (zero cost).
- Inherited methods: the stub is installed as an own property on the **concrete** class prototype
  and delegates to the inherited original. `super.m()` reaches the base implementation without
  advice unless the base class itself is woven (the same as `execution` join points being per
  declaring type). `ORIGINAL` prevents double wrapping.
- Nest lifecycle hooks (`onModuleInit`, `onApplicationBootstrap`, `onModuleDestroy`,
  `beforeApplicationShutdown`, `onApplicationShutdown`) and `constructor` are excluded from broad
  pointcuts and can be included explicitly with `P.method(Type, 'onModuleInit')`.

---

## 4. Public API

### 4.1 Concept mapping

| Spring                                                                   | This library                                                                                      | Notes                                                                                   |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `@EnableAspectJAutoProxy`                                                | `AopModule.forRoot(options)` (global)                                                             | Imported once.                                                                          |
| `@Aspect` + `@Component`                                                 | `@Aspect({ order?, instantiation? })` - implies `@Injectable()`, listed in a module's `providers` | Nest has no component scanning, so registering in a module corresponds to `@Component`. |
| `@Pointcut` method                                                       | `const pc = P.…` exported constant                                                                | A refactoring-safe reference instead of a string name.                                  |
| AspectJ expression                                                       | `P` combinators (§4.3)                                                                            | Typed.                                                                                  |
| `@Before`, `@AfterReturning`, `@AfterThrowing`, `@After`, `@Around`      | Same names                                                                                        | Same semantics, async-aware (§5.3).                                                     |
| `returning="v"` / `throwing="ex"`                                        | Second parameter of the advice; `{ throwing: ErrorClass }`                                        | Type-checked.                                                                           |
| `args(a,..)` binding                                                     | `P.args(A, P.REST)` → `jp.args` is typed as `[A, ...unknown[]]`                                   | No name binding needed.                                                                 |
| `@annotation(x)` binding                                                 | `P.annotated(Ann)` → `jp.annotation(Ann)` is typed                                                | Callable only when the pointcut proves presence.                                        |
| Java annotation                                                          | `createAnnotation(name)` (or Nest `Reflector.createDecorator`)                                    | Typed value, optional method contract.                                                  |
| `@Order` / `Ordered`                                                     | `@Aspect({ order })`, `Advisor.order`                                                             | Lower means higher precedence.                                                          |
| `perthis`/`pertarget`                                                    | `instantiation: 'perTarget'`                                                                      | Identical under in-place weaving (`this === target`).                                   |
| `pertypewithin`                                                          | `instantiation: 'perClass'`                                                                       |                                                                                         |
| `@DeclareParents`                                                        | `@DeclareParents(...)`                                                                            | §4.6.                                                                                   |
| `Advisor`, `MethodInterceptor`, `Pointcut` (ClassFilter + MethodMatcher) | Same concepts, TS interfaces                                                                      | §4.7.                                                                                   |
| `AdvisorAdapterRegistry`                                                 | `AdviceAdapter` SPI                                                                               | §4.7.                                                                                   |
| `ReactiveAdapterRegistry`                                                | `ReturnValueAdapter` registry                                                                     | §5.3.                                                                                   |
| `ProxyFactory` / `AspectJProxyFactory`                                   | `createAopProxy(target, { aspects, advisors })`                                                   | Phase 3; ES `Proxy`; the only path that supports `TargetSource`.                        |
| `Advised` (introspection)                                                | `AopInspector` (read-only) + bootstrap weaving report                                             |                                                                                         |
| `AopContext.currentProxy()`                                              | Not needed                                                                                        | Self-invocation is advised.                                                             |
| `bean(name*)`                                                            | `P.bean('userService' \| /Service$/ \| Class)`                                                    | Matches the provider token.                                                             |
| package                                                                  | Nest module (`P.inModule`)                                                                        | C3.                                                                                     |

### 4.2 Setup

```ts
@Module({
  imports: [AopModule.forRoot()],
  providers: [ResilienceAspect, AuditAspect],
})
export class AppModule {}
```

`AopModule.forRoot(options)`:

| Option                | Default            | Purpose                                                                                                                                             |
| --------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `returnValueAdapters` | `[promiseAdapter]` | Adds `observableAdapter` (from the `/rxjs` subpath) and others.                                                                                     |
| `report`              | `'debug'`          | Logs the weaving report (`UserService.findById ← Resilience.retry(around, order 10)`).                                                              |
| `strict`              | `true`             | Bootstrap error for: unused `requiresAdvice` annotations, async advice on a synchronous join point, request-scoped aspects, introduction conflicts. |
| `exclude`             | `[]`               | Additional class filters for classes that must never be woven.                                                                                      |

Testing: weaving happens during `compile()`, so advice works without `module.init()`
(lifecycle hooks still need it as usual).

### 4.3 Pointcuts

#### 4.3.1 Designators

| `P.`                                         | Spring equivalent                          | Kind                        | Shape contributed                                                           |
| -------------------------------------------- | ------------------------------------------ | --------------------------- | --------------------------------------------------------------------------- |
| `method(Type, 'name')`                       | `execution(* Type.name(..))`               | static                      | Exact `target`, `args`, `returns` of that method                            |
| `within(...Types)`                           | `within(Type)`                             | static                      | `target`                                                                    |
| `target(Type)`                               | `target(Type)` (`this` is the same object) | static                      | `target`                                                                    |
| `name('find*' \| /^find/)`                   | Name pattern of `execution`                | static                      | -                                                                           |
| `kind('method' \| 'getter' \| 'setter')`     | - (AspectJ `get`/`set` for accessors)      | static                      | -                                                                           |
| `annotated(Ann)`                             | `@annotation(Ann)`                         | static                      | `args`/`returns` from the annotation method contract, guaranteed annotation |
| `withinAnnotated(Ann)`                       | `@within(Ann)`                             | static                      | Guaranteed annotation                                                       |
| `targetAnnotated(Ann)`                       | `@target(Ann)`                             | static                      | Guaranteed annotation                                                       |
| `args(A, P.ANY, P.REST)`                     | `args(A, *, ..)`                           | **dynamic**                 | `args` tuple                                                                |
| `argsAnnotated(Ann, …)`                      | `@args(Ann)`                               | dynamic                     | -                                                                           |
| `bean(token)`                                | `bean(name)`                               | static                      | -                                                                           |
| `inModule(Module, { transitive })`           | `within(pkg..*)`                           | static                      | -                                                                           |
| `metadata(key, predicate?)`                  | -                                          | static                      | Arbitrary `Reflect` metadata (interop with existing decorators)             |
| `matching({ classFilter?, methodMatcher? })` | Custom `Pointcut`                          | static/dynamic              | -                                                                           |
| `cflow(pc)` / `cflowBelow(pc)`               | `ControlFlowPointcut` / AspectJ `cflow`    | dynamic (AsyncLocalStorage) | - (phase 3)                                                                 |

Composition: `.and()`, `.or()`, `.not()`, plus `P.all(...)` and `P.any(...)`.

#### 4.3.2 Static versus dynamic

Every pointcut compiles to `{ classFilter, methodMatcher }` with `methodMatcher.isRuntime`. The
static part runs once at weaving time. Only advisors whose static part matched are attached to the
join point, and the dynamic part (`args`, `cflow`, `matching` with `isRuntime`) runs on every
call, exactly like Spring's `InterceptorAndDynamicMethodMatcher`. Spring's recommendation applies
unchanged: combine a cheap scoping designator (`within`, `inModule`, `annotated`) with the dynamic part.

#### 4.3.3 Named shared pointcuts

```ts
// pointcuts.ts - equivalent to Spring's CommonPointcuts
export const inServiceLayer = P.inModule(ServiceModule, { transitive: true });
export const inDataAccess = P.inModule(DataModule);
export const businessService = inServiceLayer.and(P.kind("method"));
export const idempotent = P.annotated(Idempotent);
export const retryableBusinessOp = businessService.and(idempotent);
```

Plain constants alone give go-to-definition, rename refactoring and reuse across files - what
Spring achieves with `@Pointcut` method names inside strings.

#### 4.3.4 Why v1 has no string expressions

A string such as `"execution(* *Service.find*(..))"` cannot carry types to the advice (C1), cannot
be checked by the compiler, and needs a separate parser. The combinators cover every designator
Spring supports. A tagged-template parser that compiles to the same combinators can be added later
without changing the core (it is just another pointcut factory).

### 4.4 Annotations

```ts
export interface RetryOptions {
  attempts: number;
  backoffMs?: number;
}

// the value type, and the method contract this annotation can be applied to
export const Retryable = createAnnotation<
  "Retryable",
  RetryOptions,
  (...args: any[]) => Promise<unknown>
>("Retryable", { requiresAdvice: true });

export const Audited = createAnnotation<"Audited">("Audited"); // no value: @Audited()
```

- Usable on methods and classes. On methods the decorator is typed with
  `TypedPropertyDescriptor<T extends F>`: applying `@Retryable` to a synchronous method is a
  compile error (the "Retryable requires a method that returns a Promise" line in the sketch).
  An annotation without a method contract is also usable on accessors.
- The value type is enforced: `@Retryable()` without options is a compile error.
- `requiresAdvice: true`: a bootstrap error when a method is annotated but no advisor matched
  (the silent no-op that occurs in `@toss/nestjs-aop` when the aspect provider is missing).
- Lookup order of `jp.annotation(A)`: the method first, then the declaring class, then the target
  class (the lookup order of Spring's `@Transactional` attributes). Class annotations are
  inherited, so each class step includes the superclasses of that class.
- Nest's own `Reflector.createDecorator<T>()` decorators are also accepted by `P.annotated()` /
  `jp.findAnnotation()`, typed with their `T`.

The annotation name literal (`'Retryable'`) is part of the type and lets the compiler track which
annotations a pointcut guarantees (`.or()` keeps only those guaranteed by both sides).

### 4.5 Aspects and advice

```ts
const retryable = P.annotated(Retryable);
const findById = P.method(UserService, "findById");
const accountOps = P.within(AccountService).and(P.args(Account, P.REST));

@Aspect({ order: 10 })
export class ResilienceAspect {
  constructor(private readonly metrics: MetricsService) {} // regular DI

  @Around(retryable)
  async retry(jp: PJP<typeof retryable>): Promise<unknown> {
    const { attempts } = jp.annotation(Retryable); // RetryOptions
    for (let i = 1; ; i++) {
      try {
        return await jp.proceed(); // re-runs the inner chain
      } catch (e) {
        if (i >= attempts) throw e;
      }
    }
  }

  @AfterReturning(findById)
  cache(jp: JP<typeof findById>, user: User): void {} // awaited return type

  @AfterThrowing(findById, { throwing: NotFoundError })
  onMissing(jp: JP<typeof findById>, error: NotFoundError): void {}

  @Before(accountOps)
  check(jp: JP<typeof accountOps>): void {
    const account: Account = jp.args[0]; // typed by P.args
  }
}
```

Signatures enforced by the advice decorators (`JP<pc>` / `PJP<pc>` are helper aliases for
`JoinPoint<ShapeOf<pc>>` / `ProceedingJoinPoint<ShapeOf<pc>>`):

| Advice                                 | Required method type                                     | Return value                                      |
| -------------------------------------- | -------------------------------------------------------- | ------------------------------------------------- |
| `@Before(pc)`                          | `(jp: JoinPoint<S>) => R`                                | Ignored                                           |
| `@After(pc)`                           | `(jp: JoinPoint<S>) => R`                                | Ignored                                           |
| `@AfterReturning(pc)`                  | `(jp: JoinPoint<S>, result: Awaited<S['returns']>) => R` | Ignored (cannot replace the result, as in Spring) |
| `@AfterThrowing(pc, { throwing?: E })` | `(jp: JoinPoint<S>, error: E) => R`                      | Ignored; throwing replaces the error              |
| `@Around(pc)`                          | `(jp: ProceedingJoinPoint<S>) => S['returns']`           | Becomes the caller's result                       |

`R` is `void | PromiseLike<void>` when the join point is (or may be) asynchronous, and plain
`void` when it is known to be synchronous. Returning a Promise from advice on a synchronous join
point is a compile error (sketch: "async advice on a join point known to be synchronous"), and a
runtime `AopUsageError` for broad pointcuts where this is not statically known.

Compile-time errors verified with `docs/sketch/api.ts`:

| Misuse                                                                    | Error                                                     |
| ------------------------------------------------------------------------- | --------------------------------------------------------- |
| `@Retryable` on a non-Promise method                                      | TS1241, `User` is not `Promise<unknown>`                  |
| `@Retryable()` without options                                            | TS2554                                                    |
| `@Around(findById)` returning `string`                                    | `string` is not `Promise<User>`                           |
| `jp.proceedWith('x')` for `(id: number)`                                  | TS2345                                                    |
| `@AfterReturning(findById)` taking `result: string`                       | `User` is not `string`                                    |
| `{ throwing: NotFoundError }` taking `error: ConflictError`               | `NOT_FOUND` vs `CONFLICT`                                 |
| `async` `@Before` on a synchronous method                                 | `async advice is not allowed on a synchronous join point` |
| `P.method(UserService, 'nope')`                                           | Not a method key                                          |
| `jp.annotation(Audited)` when the pointcut does not guarantee it          | `'Audited'` is not `never`                                |
| `jp.annotation(Audited)` on `annotated(Audited).or(annotated(Retryable))` | Not guaranteed on every match                             |

Known limits of type checking (limits of TypeScript, not of this design): structurally identical
classes are interchangeable (`RangeError` and `TypeError` are not distinguished - the sketch keeps
this as a passing case); method parameter bivariance; `any` and assertions escape the checks;
broad pointcuts (`within`, `name`) give `unknown[]` / `unknown` - narrowing comes from `P.method`,
`P.args`, or annotation contracts.

#### JoinPoint API

```ts
interface JoinPoint<S> {
  readonly kind: "method" | "getter" | "setter";
  readonly target: S["target"]; // also Spring's `this`
  readonly args: Readonly<S["args"]>;
  readonly signature: { name; declaringType; targetType; isAsync };
  readonly bean: { token: InjectionToken; module: Type }; // Nest-specific context
  annotation<A>(a: A): ValueOf<A>; // guaranteed annotations only
  findAnnotation<A>(a: A): ValueOf<A> | undefined;
  introduced<I>(token: IntroductionToken<I>): I; // §4.6
  toString(): string; // "UserService.findById(1)"
}
interface ProceedingJoinPoint<S> extends JoinPoint<S> {
  proceed(): S["returns"];
  proceedWith(...args: S["args"]): S["returns"];
}
```

### 4.6 Introductions

```ts
export abstract class UsageTracked {                     // runtime token for the interface
  abstract incrementUseCount(): void;
  abstract get useCount(): number;
}
class DefaultUsageTracked implements UsageTracked { … }

@Aspect()
export class UsageTracking {
  @DeclareParents(P.inModule(ServiceModule), { use: DefaultUsageTracked })
  static readonly mixin: UsageTracked;

  @Before(P.inModule(ServiceModule))
  record(jp: JoinPoint<AnyShape>): void {
    jp.introduced(UsageTracked).incrementUseCount();
  }
}

// elsewhere
if (isIntroduced(userService, UsageTracked)) userService.useCount;   // type guard
```

- Introductions are class-level, as in Spring (class filter only).
- Per-instance state: one delegate per target instance (`WeakMap<target, delegate>`),
  created on first use.
- TS interfaces are erased, so the token must be a runtime value (an abstract class).
- TypeScript cannot widen the declared type of `UserService`, so callers use
  `isIntroduced` / `introduced(obj, Token)`.
- A conflict with an existing member is a bootstrap error unless `{ override: true }` is set
  (Spring silently lets the introduction win).

### 4.7 Low-level API (for library authors)

Corresponds to Spring's `Advisor` / AOP Alliance layer; `@Aspect` compiles to it.

```ts
interface Pointcut {
  classFilter: ClassFilter;
  methodMatcher: MethodMatcher;
}
interface MethodMatcher {
  matches(method: MethodRef, targetType: Type): boolean;
  readonly isRuntime: boolean;
  matchesRuntime?(
    method: MethodRef,
    targetType: Type,
    args: readonly unknown[],
  ): boolean;
}
interface MethodInvocation {
  readonly joinPoint: JoinPoint<AnyShape>;
  proceed(): unknown;
}
interface MethodInterceptor {
  invoke(invocation: MethodInvocation): unknown;
}

interface PointcutAdvisor {
  pointcut: Pointcut;
  advice: Advice;
  order?: number;
}

@AopAdvisor() // injectable, auto-detected
export class TransactionAdvisor implements PointcutAdvisor {
  constructor(private readonly tx: TransactionManager) {}
  readonly pointcut = P.annotated(Transactional).or(
    P.withinAnnotated(Transactional),
  );
  readonly advice: MethodInterceptor = { invoke: (inv) => this.tx.run(inv) };
  readonly order = 100;
}
```

- `AdviceAdapter` SPI: `{ supports(advice): boolean; toInterceptor(advice): MethodInterceptor }`
  - adds a new advice kind without touching the core.
- `ReturnValueAdapter` SPI (§5.3).

---

## 5. Runtime semantics

### 5.1 Chain construction

For each woven (class, key):

1. Collect the matching advisors (static part).
2. Sort: aspect/advisor `order` ascending (unspecified = lowest precedence); ties are resolved by
   registration order (stable, but not part of the contract - the weaving report shows ties
   between different aspects).
3. Within one aspect: `Around → Before → After → AfterReturning → AfterThrowing`
   (Spring ≥ 5.2.7); the same kind follows declaration order (TypeScript decorators run in
   declaration order, so this is deterministic - Spring leaves it undefined).
4. Convert each advice to a `MethodInterceptor` through the adapter registry.
5. Cache `{ interceptors, dynamicMatchers }` per application and per (class, key).

### 5.2 Invocation (equivalent to `ReflectiveMethodInvocation`)

```ts
class Invocation {
  constructor(ctx, target, original, args, chain, index = 0) {}
  proceed(): unknown {
    while (this.index < this.chain.length) {
      const link = this.chain[this.index++];
      if (link.dynamic && !link.dynamic.matchesRuntime(…, this.args)) continue;
      return link.interceptor.invoke(this);
    }
    return this.original.apply(this.target, this.args);
  }
  /** used so that ProceedingJoinPoint.proceed can be called more than once */
  cloneFromHere(args = this.args) { return new Invocation(…, args, this.chain, this.index); }
}
```

`args` is a frozen copy of the arguments, as Spring's `JoinPoint.getArgs()` returns a copy:
`proceedWith` is the only way to run the rest of the chain with other arguments, and every
`proceed()` of a retrying around advice starts from the same arguments.

### 5.3 Advice kind → interceptor (async-aware)

`A` is the `ReturnValueAdapter` responsible for the result (`promiseAdapter` for instances of
`Promise`, `observableAdapter` is optional). Synchronous results take the plain path. A thenable
that is not a `Promise` (a lazy query builder, for example) is followed as `Promise.resolve(value)`
only when the join point is declared asynchronous (a native `async` function or
`design:returntype === Promise`); returned from any other method it is a plain value and passes
through untouched, because following it would run it and replace it with a promise.

| Kind            | Interceptor behavior                                                                                                                                                                                                                                                             |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Before          | `r = advice(jp)`; if `r` is a thenable: allowed only when the join point is asynchronous (a native `async` function or `design:returntype === Promise`), then `return r.then(() => inv.proceed())`; otherwise `AopUsageError`. If `r` is not a thenable, `return inv.proceed()`. |
| After (finally) | `try { res = inv.proceed() } catch (e) { advice(jp); throw e }`; if `A.supports(res)` → `A.finally(res, () => advice(jp))`, otherwise `advice(jp)`; returns `res`.                                                                                                               |
| AfterReturning  | `res = inv.proceed()`; async → `A.onSuccess(res, v => advice(jp, v))` (awaits the advice and keeps `v`); sync → `advice(jp, res)`. An advice error propagates instead of the result.                                                                                             |
| AfterThrowing   | `try { res = inv.proceed() } catch (e) { if (matches(e)) advice(jp, e); throw e }`; async → `A.onError(res, e => { if (matches(e)) await advice(jp, e); throw e })`. An error thrown by the advice replaces `e`.                                                                 |
| Around          | `advice(pjp)`, where `pjp.proceed()` = `inv.cloneFromHere().proceed()`; the return value of the advice is returned.                                                                                                                                                              |

Because the chain is ordered `Around → Before → After → AfterReturning → AfterThrowing →
target`, AfterThrowing sees only join point errors and After runs last on the way out - the same
as Spring's semantics, including asynchronous code.

`ReturnValueAdapter`:

```ts
interface ReturnValueAdapter<T = unknown> {
  supports(value: unknown): value is T;
  onSuccess(value: T, cb: (resolved: unknown) => unknown): T;
  onError(value: T, cb: (error: unknown) => unknown): T;
  finally(value: T, cb: () => unknown): T;
}
```

- `promiseAdapter` (built in): supports `value instanceof Promise`; `then` / `catch` / `finally`
  semantics, preserves the resolved value.
- `observableAdapter` (opt-in, `rxjs` peer): success = completion with the last emitted value,
  error = error notification, finally = `finalize` (also on unsubscribe). Observables are lazy, so
  advice runs at subscription time, not at call time.

### 5.4 Aspect instantiation models

| Model                 | Implementation                                                                                                                                                                                                                                                                                                                                           |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `singleton` (default) | The provider instance of the aspect.                                                                                                                                                                                                                                                                                                                     |
| `perTarget`           | One instance per target object, created lazily on the first matching call, kept in a `WeakMap<target, aspect>` and collected together with the target. It is created synchronously from the aspect's constructor dependencies resolved with `ModuleRef.get(token, { strict: false })`, so every dependency must be a singleton (validated at bootstrap). |
| `perClass`            | One instance per matched concrete class, with the same creation rules.                                                                                                                                                                                                                                                                                   |

In-place weaving has no separate proxy object, so `perthis` and `pertarget` merge into
`perTarget`.

### 5.5 Application context resolution (C8)

An advice chain belongs to an `AopContext` (one per Nest application). The stub resolves the
context for `this` as follows:

1. `WeakMap<instance, AopContext>` hit → use it.
2. Otherwise look at the set of live contexts that wove this class:
   - none → call the original (an unmanaged instance, for example `new UserService()` in a unit
     test, or an application that is already closed);
   - one → use it and cache it in the `WeakMap`;
   - several (parallel applications in one process) → static instances are compared against each
     context's instance wrappers, and scoped instances fall back to the most recently created
     context and print a warning once.
3. `onApplicationShutdown` unregisters the context. Stubs of classes with no remaining context
   pass straight through.

Sequential test suites (create → close → create) are the common case and work correctly.

### 5.6 Scopes

- **Targets**: every scope. The stub lives on the prototype, so request-scoped and transient
  instances created later are advised as well (spike: `ScopedThing`).
- **Aspects**: must be singletons (`DEFAULT` scope). An aspect that depends on a request-scoped
  provider implicitly becomes request-scoped through Nest's scope bubbling. `strict` mode rejects
  this at bootstrap with a message that points to `ModuleRef.resolve`, `ContextIdFactory`, or a
  CLS store. Per-call context belongs to the join point, not to the aspect instance.
- **Aspects are never advised** (Spring rule). This also prevents recursion.

### 5.7 Position in the Nest request pipeline

```
Middleware → Guards → Interceptors (pre) → Pipes → [ AOP chain → controller method ]
           → Interceptors (post) → Exception filters
```

Advice on a controller method runs inside Nest interceptors and after pipes (arguments are already
transformed). Errors thrown by advice reach exception filters normally. Nest interceptors remain
the right tool for HTTP-layer concerns, while aspects target every provider method regardless of
transport.

### 5.8 Bootstrap validation (`strict`)

- Advice decorator used in a class without `@Aspect` → error.
- `requiresAdvice` annotation with no matching advisor → error listing the methods.
- Pointcut that matches nothing → warning (Spring pitfall: typos fail silently).
- Async advice on a synchronous join point (when not statically known) → error on the first call.
- Introduction member conflict → error.
- Request-scoped aspect / non-singleton dependency of a `perTarget` aspect → error.
- Identical `order` between different aspects advising the same join point → warning.

### 5.9 Cost

- Weaving: once at bootstrap, O(classes × methods × advisors) static matching. The class filter
  runs first, so most advisors are filtered out per class rather than per method.
- Unadvised methods: untouched.
- Advised calls: one context lookup (WeakMap), one `Invocation` object, one closure per
  around/proceed; dynamic matchers only where declared. `cflow` (phase 3) uses AsyncLocalStorage
  only when such a pointcut exists.

---

## 6. Deliberate differences from Spring

| Topic                                       | Spring AOP                       | This design                                | Reason                                                                      |
| ------------------------------------------- | -------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------- |
| Self-invocation                             | Not advised (proxy)              | **Advised**                                | In-place weaving; removes Spring's most common pitfall (AspectJ semantics). |
| `this` versus `target`                      | Different objects                | The same object                            | There is no proxy. `P.target` covers both.                                  |
| Order of same-kind advice within one aspect | Undefined                        | Declaration order                          | TS decorators preserve it.                                                  |
| Asynchronous results                        | Advice sees the future/publisher | Advice follows settlement                  | C4.                                                                         |
| Join point kinds                            | Methods                          | Methods + accessors (opt-in with `P.kind`) | Cheap under prototype weaving.                                              |
| Pointcut language                           | AspectJ strings                  | Typed combinators                          | C1.                                                                         |
| Packages                                    | `within(pkg..*)`                 | `P.inModule`                               | C3.                                                                         |
| Silent non-matches                          | Silent                           | `requiresAdvice`, match warnings           | Determinism goal.                                                           |
| `Advised` mutation                          | Supported                        | Read-only inspector                        | Prototype-level weaving is shared, so mutations leak between instances.     |
| Introduction conflicts                      | The introduction wins            | Error unless `override`                    | Determinism goal.                                                           |
| `perthis`/`pertarget`                       | Separate                         | Merged into `perTarget`                    | There is no proxy.                                                          |

---

## 7. Spring feature coverage

| #   | Spring feature (analysis §12)                    | Phase         | Design                                                                                                   |
| --- | ------------------------------------------------ | ------------- | -------------------------------------------------------------------------------------------------------- |
| F1  | Aspects as beans with DI                         | 1             | §4.5                                                                                                     |
| F2  | Auto-detection / auto-weaving                    | 1             | §3.3                                                                                                     |
| F3  | Named, composable pointcuts                      | 1             | §4.3.3                                                                                                   |
| F4  | `execution`                                      | 1             | `P.method`, `P.name`, `P.kind`; no return/parameter _type patterns_ (C1)                                 |
| F5  | `within`                                         | 1             | `P.within`, `P.inModule`                                                                                 |
| F6  | `this` / `target`                                | 1             | `P.target`                                                                                               |
| F7  | `args` with binding                              | 1             | `P.args`                                                                                                 |
| F8  | `@annotation`/`@within`/`@target`/`@args`        | 1 (`@args` 2) | §4.3.1                                                                                                   |
| F9  | `bean()`                                         | 1             | `P.bean`                                                                                                 |
| F10 | Static/dynamic matching, caching                 | 1             | §4.3.2, §5.1                                                                                             |
| F11 | Custom / regex / control flow pointcuts          | 1 (cflow 3)   | `P.matching`, `P.name(RegExp)`, `P.cflow`                                                                |
| F12 | Five advice kinds                                | 1             | §5.3                                                                                                     |
| F13 | Typed advice parameters                          | 1             | §4.5                                                                                                     |
| F14 | `proceed()` / `proceed(args)` / multiple proceed | 1             | §5.2                                                                                                     |
| F15 | JoinPoint API                                    | 1             | §4.5                                                                                                     |
| F16 | Ordering                                         | 1             | §5.1                                                                                                     |
| F17 | Advisor / MethodInterceptor API                  | 1             | §4.7                                                                                                     |
| F18 | Advice adapter SPI                               | 2             | §4.7                                                                                                     |
| F19 | Introductions                                    | 2             | §4.6                                                                                                     |
| F20 | Instantiation models                             | 2             | §5.4                                                                                                     |
| F21 | Programmatic proxies                             | 3             | `createAopProxy`                                                                                         |
| F22 | `Advised`                                        | 2 (read-only) | `AopInspector`                                                                                           |
| F23 | `TargetSource`                                   | 3             | `createAopProxy` only                                                                                    |
| F24 | `exposeProxy` / `AopContext`                     | -             | Unnecessary (self-invocation is advised)                                                                 |
| F25 | Schema-style aspects                             | 3             | `AopModule.forRoot({ aspects: [{ ref, before: [{ pointcut, method }] }] })`, `method` typed with `keyof` |
| F26 | Proxy type control                               | -             | Not applicable                                                                                           |
| F27 | Full AspectJ                                     | -             | Non-goal                                                                                                 |

Phase 1 = core release. Phase 2 = introductions, instantiation models, Observable adapter,
advice SPI, inspector. Phase 3 = cflow, programmatic proxies with TargetSource,
configuration-style aspects, optional string expression front end.

---

## 8. `@toss/nestjs-aop` - lessons applied

| Observed in 2.2.1                                                                                                                                                                              | Result                                                                                                   | Response here                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `createDecorator(key, metadata?)` returns an untyped `MethodDecorator`, and `WrapParams` has `instance: any`, `method: Function`, `metadata: unknown` (toss/nestjs-aop#42, toss/nestjs-aop#63) | The decorated method and the aspect are not checked against each other                                   | Annotation method contract + pointcut shape + typed advice signatures (§4.4-4.5)                                   |
| Only `wrap()` (around-like) exists                                                                                                                                                             | Every concern reimplements before/after/error handling, and asynchronous handling is left to each aspect | Five advice kinds with async adapters (§5.3)                                                                       |
| Matching only by the aspect's own decorator symbol                                                                                                                                             | No `within`, name, module or class-level matching (toss/nestjs-aop#34)                                   | Pointcut designators (§4.3)                                                                                        |
| Order = decorator application order                                                                                                                                                            | No precedence between aspects                                                                            | `order` + Spring's in-aspect order (§5.1)                                                                          |
| Weaving in `AutoAspectExecutor.onModuleInit` of a non-global module                                                                                                                            | Earlier hooks run without advice - reproduced (`spike/nestjs-aop-lifecycle.ts`)                          | Weaving during instantiation (§3.3)                                                                                |
| Missing aspect provider → the decorated method silently runs without advice                                                                                                                    | Silent production bug                                                                                    | `requiresAdvice`, strict validation (§5.8)                                                                         |
| For non-static wrappers the wrapper function is stored on `metatype.prototype[aopSymbol]`                                                                                                      | Shared between applications in one process                                                               | Per-application `AopContext` (§5.5)                                                                                |
| Per-instance lazy wrapping with a `WeakMap` cache; `wrap()` is rebuilt per instance (toss/nestjs-aop#28)                                                                                       | Per-instance work; easy to regress                                                                       | Chain cached per application and per (class, key); per-instance state only for `perTarget` aspects / introductions |
| `Object.setPrototypeOf(wrapperFn, originalFn)` to keep metadata (toss/nestjs-aop#15)                                                                                                           | Works                                                                                                    | Kept (C10)                                                                                                         |
| Supports accessors, but not get+set of one property                                                                                                                                            | Limitation                                                                                               | Getter and setter are woven independently (`P.kind`)                                                               |
| `console.debug` in library code                                                                                                                                                                | Noise                                                                                                    | Nest `Logger`, report level option                                                                                 |

---

## 9. Extensibility check

"How many files change when a third variant is added?"

| Variant                                                      | Files changed                                                            |
| ------------------------------------------------------------ | ------------------------------------------------------------------------ |
| New pointcut designator                                      | 1 (`pointcut/designators/<name>.ts`) + one export line                   |
| New advice kind                                              | 1 adapter (`advice/adapters/<kind>.ts`) + the decorator in the same file |
| New asynchronous return type (for example `AsyncIterable`)   | 1 `ReturnValueAdapter`, registered through options                       |
| New instantiation model                                      | 1 (`aspect/instantiation/<model>.ts`)                                    |
| New kind of Nest entry point (for example another transport) | 0 - weaving is transport-agnostic                                        |

---

## 10. Package layout (proposal)

```
src/
  index.ts                      public exports
  module/aop.module.ts          AopModule.forRoot, AOP_WEAVER factory, lifecycle
  annotation/                   createAnnotation, Reflector interop, lookup order
  pointcut/
    pointcut.ts                 Pointcut, ClassFilter, MethodMatcher, combinators
    designators/                method, within, target, name, kind, annotated, args, bean, in-module, metadata, matching
  aspect/
    decorators.ts               @Aspect, @Before … @Around, @DeclareParents, @AopAdvisor
    aspect-compiler.ts          aspect metadata → PointcutAdvisor[]
    instantiation/              singleton, per-target, per-class
  advice/
    interceptor.ts              MethodInterceptor, MethodInvocation
    adapters/                   before, after, after-returning, after-throwing, around
  invocation/
    invocation.ts               chain traversal, clone for proceed
    join-point.ts               JoinPoint / ProceedingJoinPoint
  return-value/                 promise (built in), observable (subpath export `/rxjs`)
  weaving/
    weaver.ts                   candidate scan, static matching, stub installation
    stub.ts                     dispatcher, ORIGINAL unwrap, metadata preservation
    context.ts                  AopContext registry (§5.5)
  introduction/                 delegates, isIntroduced
  inspect/                      AopInspector, weaving report
  errors.ts                     AopConfigurationError, AopUsageError, AopNotReadyError
```

Build: tsdown produces separate CJS and ESM outputs with matching declarations; type tests in the
style of `docs/sketch/api.ts` (`@ts-expect-error` fixtures) are checked by the package
`typecheck` script; runtime tests are `*.test.ts`.

---

## 11. Open questions

1. **Self-invocation:** keep AspectJ semantics (advised) as the only behavior, or offer a
   Spring-compatible mode that skips advice for calls made from inside the same instance? The
   latter needs AsyncLocalStorage bookkeeping on every advised call.
2. **Observable semantics:** is "completion with the last value" the right `AfterReturning`
   meaning for a stream, or should Observable support be per emission?
3. **Naming:** the package name is `nestjs-aspect`. Whether to keep the Spring names (`@Aspect`,
   `@Around`) or use Nest-flavored names remains open.
4. **Minimum Nest version:** the design uses only public APIs that exist since Nest 8
   (`ModulesContainer`, `Reflector`, lifecycle hooks), while the package targets NestJS 12 on
   Node.js 24 and ships both module formats (CJS and ESM). Whether to support earlier Nest majors
   remains open.
5. **Lazy-loaded modules** (`LazyModuleLoader`): weave on load through an explicit
   `AopWeaver.weave(moduleRef)` call, or wrap `LazyModuleLoader`?

## 12. Accepted trade-offs

- Calls made in a constructor before the weaver runs may not be advised (§3.3). A call made before
  the aspect is instantiated throws `AopNotReadyError` instead of skipping the advice.
- Parallel Nest applications in one process that weave the same class differently fall back to the
  "most recent context" for scoped instances (§5.5).
- Arrow-function fields and `#private` methods cannot be advised (C9).
- Type checking is structural: identical error classes are interchangeable, and broad pointcuts
  type `args`/`returns` as `unknown`.
- Return type and parameter type _patterns_ of `execution` are not supported (C1).
- There is no live mutation of the advice chain.
