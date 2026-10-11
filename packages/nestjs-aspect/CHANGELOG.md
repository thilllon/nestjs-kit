# nestjs-aspect

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
