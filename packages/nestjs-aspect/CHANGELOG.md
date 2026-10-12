# nestjs-aspect

## 0.0.5

### Patch Changes

- 2aaa56a: Fix three weaving defects.

  - A `LazyModuleLoader.load()` that an introduction collision rejects weaves the other classes of the loaded modules, so a `requiresAdvice` member of such a class no longer runs without advice. Every later `load()` reports the collision again.
  - A subclass that inherits a woven member and matches no advisor runs the original function once a lazy module registers it or the `exclude` option names it, also when one of its instances was called before.
  - An instance of a `perTarget` or `perClass` aspect receives the provider that the module of the aspect registers under a token, instead of the provider another module registers under the same token.

## 0.0.4

### Patch Changes

- dc69ca2: Publish the README with the provider-level examples and recipes: an audit trail with an actor, permission checks, cache eviction after a commit, upstream error translation, retries with backoff, a transaction recipe, a job recipe and repository timing.

## 0.0.3

### Patch Changes

- 6b25391: Export the pointcut designator namespace as `Pointcut` in place of `P`. The name is both the namespace and the `Pointcut<Shape>` type; import it with an alias, such as `import { Pointcut as P } from "nestjs-aspect"`, to keep `P.method(...)` call sites.

## 0.0.2

### Patch Changes

- b4e85c1: Spell out the abbreviated type names. `JP` is `JoinPointOf`, `PJP` is `ProceedingJoinPointOf`, `Fn` is `AnyFunction`, and the `ann` member of `Shape` is `annotations`. The abbreviated names are removed.

## 0.0.1

### Patch Changes

- f815614: Add `nestjs-aspect`, Spring-style aspect-oriented programming for NestJS 12.

  - `AspectModule.forRoot()` and `forRootAsync()` weave the aspects of an application into every class its container manages (providers, controllers, enhancers and middleware of every scope) before the router binds route handlers and before the first lifecycle hook. The classes of a module loaded with `LazyModuleLoader` are woven when `load()` resolves. Options: `returnValueAdapters`, `adviceAdapters`, `report`, `strict` and `exclude`.
  - `@Aspect` classes are providers with the advice decorators `@Before`, `@AfterReturning`, `@AfterThrowing`, `@After` and `@Around`, ordered by `order` and by the Spring rules within one aspect. Advice follows the settlement of promises, and of Observables with `observableAdapter` from the `nestjs-aspect/rxjs` entry.
  - The `P` designators (`method`, `within`, `target`, `name`, `kind`, `annotated`, `withinAnnotated`, `targetAnnotated`, `args`, `bean`, `inModule`, `metadata`, `matching`) build typed pointcuts that compose with `and`, `or` and `not`; the advice decorators check advice signatures against them.
  - `createAnnotation` creates typed annotations with an optional method contract; `requiresAdvice` rejects the bootstrap and the call of an annotated member that no advisor handles, and the call of such a member on an instance of a closed application.
  - `@Advisor` with `MethodInterceptor`, and the `AdviceAdapter` and `ReturnValueAdapter` extension interfaces with the built-in `promiseAdapter`.
  - The `perTarget` and `perClass` aspect instantiation models, and introductions with `@DeclareParents`, `isIntroduced` and `introduced`.
  - `AspectInspector` and the weaving report list the advised members and their advisors; the bootstrap validation raises `AspectConfigurationError`, and `AspectUsageError` and `AspectNotReadyError` report misuse at run time.
