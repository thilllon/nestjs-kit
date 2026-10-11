# nestjs-aspect

**Spring-style aspect-oriented programming for NestJS.** Aspects are Nest providers whose advice runs around the methods their pointcuts select.

[![npm version](https://img.shields.io/npm/v/nestjs-aspect)](https://www.npmjs.com/package/nestjs-aspect)
[![npm monthly downloads](https://img.shields.io/npm/dm/nestjs-aspect)](https://www.npmjs.com/package/nestjs-aspect)
[![CI](https://img.shields.io/github/actions/workflow/status/thilllon/nestjs-kit/ci.yml?branch=main)](https://github.com/thilllon/nestjs-kit/actions/workflows/ci.yml)

Version `0.0.0` on npm exports the declaration API only: annotations, pointcuts, aspect and advice decorators, the advisor interfaces and the error classes. `AspectModule`, which weaves aspects into a Nest application, is not part of that version; it ships with the next release.

## Installation

```sh
pnpm add nestjs-aspect
```

`@nestjs/common`, `@nestjs/core`, `reflect-metadata` and `rxjs` are peer dependencies.

Requires **Node.js 24+** and **NestJS 12**. Ships ESM, CommonJS, and TypeScript declarations. Aspects use legacy decorators: enable `experimentalDecorators` and `emitDecoratorMetadata`.

## Setup

Import `AspectModule.forRoot()` once, as the first import of the root module, and register aspects as providers of any module.

```ts
import { Module } from "@nestjs/common";
import { AspectModule } from "nestjs-aspect";

@Module({
  imports: [AspectModule.forRoot()],
  providers: [UserService, ResilienceAspect],
})
export class AppModule {}
```

The module is global. It weaves the classes the Nest container registers: providers, controllers, guards, interceptors, pipes, filters and middleware, of every scope. Weaving replaces a matched method on the class prototype with a dispatcher that runs the advice of the application the object belongs to. It happens while Nest instantiates providers, so advice is in place before the router binds route handlers and before the first lifecycle hook, and after `Test.createTestingModule(...).compile()` without `init()`. A middleware class that is only passed to `consumer.apply()` and the instance of a singleton factory or value provider are woven when the application initializes ([Limits](#limits)).

Nest runs the `onModuleInit` hooks of global modules in import order and their `onApplicationShutdown` hooks in reverse order. With `AspectModule` imported first, its weaving is complete before the hooks of every other module, and it shuts down after them.

| Option                | Default   | Purpose                                                                                                                                     |
| --------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `returnValueAdapters` | `[]`      | `ReturnValueAdapter`s for asynchronous result types other than `Promise`, consulted in order before the built-in `promiseAdapter`.          |
| `report`              | `"debug"` | Logger level (`"verbose"`, `"debug"` or `"log"`) of the weaving report; `false` logs none.                                                  |
| `strict`              | `true`    | The [bootstrap validations](#bootstrap-validation) fail `init()` with `AspectConfigurationError`. With `false` they are logged as warnings. |
| `exclude`             | `[]`      | Classes that are never woven: a class excludes itself and its subclasses, a `ClassFilter` the classes it matches.                           |

`AspectModule.forRootAsync({ useFactory, inject, imports })` resolves the options from singleton providers. The weaver waits for them inside the instantiation phase; a provider factory that runs before the options are resolved calls its dependencies without advice.

## Annotations

`createAnnotation(name, options?)` creates a typed metadata decorator for methods and classes; an annotation without a method contract also applies to accessors. Its type parameters are the name literal, the value type and the method contract the annotation accepts.

```ts
import { createAnnotation } from "nestjs-aspect";

export interface RetryOptions {
  attempts: number;
}

// Applies only to methods that return a Promise, and requires RetryOptions.
export const Retryable = createAnnotation<
  "Retryable",
  RetryOptions,
  (...args: any[]) => Promise<unknown>
>("Retryable", { requiresAdvice: true });

export const Audited = createAnnotation<"Audited">("Audited");

export class UserService {
  @Retryable({ attempts: 3 })
  async findById(id: number): Promise<User> {
    return this.users.load(id);
  }

  @Audited()
  rename(user: User, name: string): User {
    return user.withName(name);
  }
}
```

- The annotation name is its identity: annotations created with the same name read and write the same metadata.
- A method annotation belongs to the method that declares it; an override without the annotation does not carry it. A class annotation is inherited by subclasses.
- `requiresAdvice` marks an annotation whose members must be matched by an advisor that handles it: one whose pointcut refers to the annotation with `P.annotated`, `P.withinAnnotated` or `P.targetAnnotated`, in any composition, or whose pointcut comes from `P.matching` or is hand-written.
- `isAnnotation(value)` tells an annotation from other functions.
- Decorators created with Nest's `Reflector.createDecorator()` are accepted by `P.annotated`, `P.withinAnnotated`, `P.targetAnnotated` and `jp.findAnnotation`.

## Pointcuts

`P` builds typed pointcuts. A pointcut carries the target, argument and return types and the annotations it guarantees, and the advice decorators check advice signatures against them.

| Designator                                   | Matches                                                                                 |
| -------------------------------------------- | --------------------------------------------------------------------------------------- |
| `P.method(Type, "name")`                     | That method on `Type` and its subclasses; carries its exact signature.                  |
| `P.within(...Types)`                         | Members declared on one of the classes.                                                 |
| `P.target(Type)`                             | Members of `Type` and its subclasses.                                                   |
| `P.name("find*" \| /^find/)`                 | Members by name; `*` in a string matches any run of characters.                         |
| `P.kind("method" \| "getter" \| "setter")`   | Members by kind.                                                                        |
| `P.annotated(A)`                             | Members that carry `A`; carries the method contract of `A`.                             |
| `P.withinAnnotated(A)`                       | Members declared on a class that carries `A`.                                           |
| `P.targetAnnotated(A)`                       | Members of a class that carries `A`.                                                    |
| `P.args(Account, P.ANY, P.REST)`             | Calls by argument, checked on every call; types `jp.args`.                              |
| `P.bean("token" \| /Service$/ \| Type)`      | Classes registered under a matching provider token; `*` in a string is a wildcard.      |
| `P.inModule(Module, { transitive })`         | Classes a Nest module declares, with `transitive` also those of the modules it imports. |
| `P.metadata(key, predicate?)`                | Members with Reflect metadata `key`, such as metadata stored by `SetMetadata`.          |
| `P.matching({ classFilter, methodMatcher })` | Members a custom class filter and method matcher accept.                                |

Compose pointcuts with `.and()`, `.or()` and `.not()`, or with `P.all(...)` and `P.any(...)`. `and` guarantees the annotations of both sides, `or` those common to both sides, and `not` none.

```ts
import { P } from "nestjs-aspect";

export const retryable = P.annotated(Retryable);
export const findById = P.method(UserService, "findById");
export const accountOps = P.within(AccountService).and(P.args(Account, P.REST));
```

Broad pointcuts match methods only, and leave out the Nest lifecycle hooks `onModuleInit`, `onApplicationBootstrap`, `onModuleDestroy`, `beforeApplicationShutdown` and `onApplicationShutdown`. `P.method` selects a lifecycle hook, and `P.kind("getter")` or `P.kind("setter")` selects accessors; a getter and a setter of one property are woven independently. A constructor is never a join point.

- `P.bean` sees the token of every registration of a class, including `useClass` tokens. A `useExisting` token and the instance of a singleton `useFactory` or `useValue` provider are matched by their token when the application initializes.
- `P.inModule(Module, { transitive: true })` follows the imports of the module. A global module counts only when the `@Module()` decorator of the importing module lists it, because Nest adds every global module to the imports of every module.
- Static designators are evaluated once per class member at weaving time. `P.args` is evaluated on every call; combine it with a static designator.

## Aspects and advice

`@Aspect({ order?, instantiation? })` marks a class as an aspect and as a Nest provider with regular constructor injection; list it in the `providers` of a module. `"singleton"` is the supported instantiation model.

```ts
import {
  AfterReturning,
  AfterThrowing,
  Around,
  Aspect,
  Before,
  type JP,
  type PJP,
} from "nestjs-aspect";

@Aspect({ order: 10 })
export class ResilienceAspect {
  constructor(private readonly metrics: MetricsService) {}

  @Around(retryable)
  async retry(jp: PJP<typeof retryable>): Promise<unknown> {
    const { attempts } = jp.annotation(Retryable); // RetryOptions
    for (let attempt = 1; ; attempt++) {
      try {
        return await jp.proceed();
      } catch (error) {
        if (attempt >= attempts) {
          throw error;
        }
      }
    }
  }

  @AfterReturning(findById)
  cache(jp: JP<typeof findById>, user: User): void {}

  @AfterThrowing(findById, { throwing: NotFoundError })
  onMissing(jp: JP<typeof findById>, error: NotFoundError): void {}

  @Before(accountOps)
  check(jp: JP<typeof accountOps>): void {
    const account: Account = jp.args[0];
  }
}
```

| Decorator                           | Advice signature                                 | Semantics                                                                      |
| ----------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------ |
| `@Before(pc)`                       | `(jp: JP<typeof pc>)`                            | Runs before the join point; an error prevents the join point from running.     |
| `@After(pc)`                        | `(jp: JP<typeof pc>)`                            | Runs after the join point, whatever its outcome.                               |
| `@AfterReturning(pc)`               | `(jp: JP<typeof pc>, result)`                    | Runs after a normal completion with the awaited result; cannot replace it.     |
| `@AfterThrowing(pc, { throwing? })` | `(jp: JP<typeof pc>, error)`                     | Runs when the join point fails, with `throwing` only for errors of that class. |
| `@Around(pc)`                       | `(jp: PJP<typeof pc>)` returning the result type | Surrounds the join point; its return value becomes the result.                 |

- `jp.annotation(A)` is callable only when the pointcut guarantees `A`; `jp.findAnnotation(A)` returns `undefined` when `A` is absent. Both look at the method, then the declaring class, then the target class. Each class step includes inherited class annotations, so for an inherited method an annotation on a superclass of the declaring class wins over one on the target class.
- `jp.args` is frozen. `jp.proceedWith(...args)` runs the rest of the chain with other arguments.
- `jp.proceed()` and `jp.proceedWith(...args)` can be called more than once; each call starts from the arguments the advice received or passes.
- Aspects and advisors are never advised.
- An aspect inherits the advice of a superclass without `@Aspect`, such as an abstract base class. An aspect that extends another `@Aspect` class is rejected.
- A call from a method to another method of the same object (`this.other()`) is advised, unlike in Spring: the dispatcher lives on the class prototype, not on a proxy.
- On a controller method, advice runs inside Nest interceptors and after pipes. An error thrown by advice reaches the exception filters like an error of the handler.

The compiler rejects an annotation on a method outside its contract, a missing or mistyped annotation value, around advice with the wrong return type, `proceedWith` arguments that do not fit the method, an after-returning result or after-throwing error parameter of the wrong type, and `P.method` with a name that is not a method of the class. Structurally identical classes are interchangeable to TypeScript, and broad pointcuts such as `P.within` and `P.name` type arguments and results as `unknown`.

## Ordering

- Across aspects and advisors a lower `order` runs first and wraps the others; one without an order has the lowest precedence. Equal orders run in registration order, which the weaver reports as a warning.
- Within one aspect the advice order is around, before, after, after returning, after throwing; advice of the same kind runs in declaration order.

## Asynchronous join points

- Advice follows the settlement of a `Promise` result, not the synchronous return. Another thenable, such as a lazy query builder, is followed only when the method is declared asynchronous: an `async` method, or a decorated method whose declared return type is `Promise`. Returned from any other method it reaches the caller untouched and is not run.
- Before, after, after-returning and after-throwing advice can be `async` when the join point is or may be asynchronous. On a join point known to be synchronous, `async` advice is a compile error; where the types cannot tell, it raises `AspectUsageError` when called.
- `async` before advice needs a method that is declared asynchronous. A method that returns a promise without being `async` and without a decorated `Promise` return type counts as synchronous for before advice.
- A `ReturnValueAdapter` in the `returnValueAdapters` option makes advice follow another result type.

## Scopes

- Targets of every scope are advised: singleton, request-scoped and transient.
- Aspects and advisors are singletons. One that is request-scoped or transient, by its own scope or because it depends on a request-scoped provider, is rejected when the application initializes. Per-request state belongs to the join point: resolve a request-scoped provider inside the advice with `ModuleRef.resolve()` and `ContextIdFactory`, or read it from a CLS store.
- An aspect class registered in several modules has one instance that serves its advice, the one of the module registered first.

## Advisors

`@Advisor()` marks a provider as a low-level advisor. The static member `pointcut` selects the join points; an instance supplies `advice`, a `MethodInterceptor`, and an optional `order`.

```ts
import { Advisor, type MethodInterceptor, P } from "nestjs-aspect";

@Advisor()
export class TransactionAdvisor {
  static readonly pointcut = P.annotated(Transactional).or(
    P.withinAnnotated(Transactional),
  );

  readonly order = 100;

  readonly advice: MethodInterceptor = {
    invoke: (invocation) => this.transactions.run(() => invocation.proceed()),
  };

  constructor(private readonly transactions: TransactionManager) {}
}
```

The pointcut is static because the weaver matches it before Nest creates the advisor instance. `@Advisor()` on a class without a static `pointcut` is a compile error and raises `AspectConfigurationError`.

The entry point also exports the extension interfaces `AdviceAdapter` and `ReturnValueAdapter`, the built-in `promiseAdapter`, and the matching interfaces `PointcutAdvisor`, `PointcutLike`, `ClassFilter`, `MethodMatcher`, `ClassRef` and `MethodRef`.

## Bootstrap validation

`AspectModule` validates the configuration in its `onModuleInit` hook and logs through the Nest `Logger` with the context `AspectModule`.

| Finding                                                                   | Result                          |
| ------------------------------------------------------------------------- | ------------------------------- |
| An aspect or advisor that is not a singleton                              | Error                           |
| An aspect or advisor supplied by a factory, value or alias provider       | Error                           |
| An advisor instance without `advice` or with an `order` that is no number | Error                           |
| Advice decorators on a class without `@Aspect`                            | Error                           |
| A `requiresAdvice` annotation on a member that no advisor handles         | Error that lists the members    |
| A `requiresAdvice` annotation on a member of an aspect or advisor         | Error that lists the members    |
| `forRootAsync` options that depend on a request-scoped provider           | Error                           |
| A pointcut that matches no member of the application                      | Warning                         |
| Different aspects with the same order, or without one, on one join point  | Warning                         |
| An aspect or advisor class registered in several modules                  | Warning                         |
| A global module with a shutdown hook imported before `AspectModule`       | Warning                         |
| `AspectModule` registered more than once, whatever the options            | Error while the module compiles |
| An aspect that extends another `@Aspect` class                            | Error while the module compiles |

An error fails `init()` with one `AspectConfigurationError`; with `strict: false` it is logged as a warning. The errors raised while the module compiles do not depend on `strict`. The weaving report follows, one line per join point and advisor in chain order:

```
UserService.findById <- ResilienceAspect.retry (around, order 10)
UserService.findById <- AuditAspect.audit (before, no order)
```

## Testing

- `Test.createTestingModule({ imports: [AppModule] }).compile()` weaves the module: advice runs without `init()`. The bootstrap validation and the weaving report run in `init()`.
- An object created with `new`, outside a container, runs its original methods when no live application weaves its class. While a live application weaves the class, the object is advised by that application.
- Close each application or testing module: `close()` detaches it from the woven classes. An application that is never closed, such as one whose `compile()` or `init()` failed, stays attached until it is garbage collected.
- Applications that weave the same class in one process stay apart: an instance is advised by the application whose container holds it, also when that application excludes the class or matches nothing in it. An instance of a closed application is not advised by a later one, unless the container of the later one holds the same object, such as a shared `useValue` instance.
- An aspect replaced with `overrideProvider(...).useValue(...)` is no aspect any more: its advice does not run.

## Limits

- A call made while Nest instantiates providers, in a constructor or a provider factory, is not guaranteed to be advised. Before the weaver has run it runs without advice. After that, a call that reaches a woven method before the instance of an aspect or advisor that advises it exists raises `AspectNotReadyError`: Nest cannot create that instance on demand.
- When several live applications weave the same class, a request-scoped or transient instance is advised by the most recently created application, which logs a warning once per class.
- An application without `AspectModule` is invisible to the others: while another live application weaves a class, the instances of that class in the application without the module are advised by it.
- A subclass that is not woven itself inherits the dispatcher of a woven superclass method and is advised by it only when the container does not manage the subclass; a `super` call from an override is advised when the superclass is woven, except in a class of the `exclude` option.
- With a global module imported before `AspectModule`, the `onApplicationShutdown` hooks of that module run after `AspectModule` has shut down, without advice, and its `onModuleInit` hooks run before the classes of factory and value providers are woven.
- An aspect or advisor is registered as a class, by itself or with `useClass`. One that a `useFactory`, `useValue` or `useExisting` provider supplies is rejected when the application initializes.
- A middleware class that is only passed to `consumer.apply()` becomes known when the application initializes, after the router has bound its `use` method: `use` itself is not advised, the methods it calls are. Register the middleware as a provider as well to have `use` advised.
- A factory or value provider is woven by the class of its instance when the application initializes, and only when it is a singleton. Modules loaded with `LazyModuleLoader` are not woven.
- Arrow-function class fields and `#private` methods cannot be advised: they are not members of the prototype.
- There are no return type or parameter type patterns; `P.method`, `P.args` and annotation contracts carry the types.
- The advice of a running application cannot be changed.

## Errors

| Class                      | Thrown when                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------ |
| `AspectConfigurationError` | Aspects, pointcuts, advice or module options are misconfigured, or a bootstrap validation fails. |
| `AspectUsageError`         | Advice is misused at run time, such as asynchronous advice on a synchronous join point.          |
| `AspectNotReadyError`      | A woven method is invoked before the instance of an aspect or advisor that advises it exists.    |

`instanceof` recognizes these errors across the CommonJS and ES module builds of the package.

## Design

[docs/design.md](https://github.com/thilllon/nestjs-kit/blob/main/packages/nestjs-aspect/docs/design.md) specifies the API, the weaving model and the error behavior. [docs/spring-aop-analysis.md](https://github.com/thilllon/nestjs-kit/blob/main/packages/nestjs-aspect/docs/spring-aop-analysis.md) describes the Spring AOP model and the feature list the design maps to. [docs/sketch/api.ts](https://github.com/thilllon/nestjs-kit/blob/main/packages/nestjs-aspect/docs/sketch/api.ts) holds a type-level sketch of the public API, and [docs/spike](https://github.com/thilllon/nestjs-kit/tree/main/packages/nestjs-aspect/docs/spike) holds runnable experiments on weaving timing.

[Contributing](https://github.com/thilllon/nestjs-kit/blob/main/CONTRIBUTING.md) · [Release setup](https://github.com/thilllon/nestjs-kit/blob/main/docs/releases.md)
