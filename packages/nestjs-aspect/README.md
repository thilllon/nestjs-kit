# nestjs-aspect

**Spring-style aspect-oriented programming for NestJS.** Aspects are Nest providers whose advice runs around the methods their pointcuts select.

[![npm version](https://img.shields.io/npm/v/nestjs-aspect)](https://www.npmjs.com/package/nestjs-aspect)
[![npm monthly downloads](https://img.shields.io/npm/dm/nestjs-aspect)](https://www.npmjs.com/package/nestjs-aspect)
[![CI](https://img.shields.io/github/actions/workflow/status/thilllon/nestjs-kit/ci.yml?branch=main)](https://github.com/thilllon/nestjs-kit/actions/workflows/ci.yml)

Version `0.0.0` exports the declaration API: annotations, pointcuts, aspect and advice decorators, the advisor interfaces and the error classes. It does not export the module that weaves aspects into a Nest application, so declared advice does not run in an application.

## Installation

```sh
pnpm add nestjs-aspect
```

`@nestjs/common`, `@nestjs/core`, `reflect-metadata` and `rxjs` are peer dependencies.

Requires **Node.js 24+** and **NestJS 12**. Ships ESM, CommonJS, and TypeScript declarations. Aspects use legacy decorators: enable `experimentalDecorators` and `emitDecoratorMetadata`.

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
- `requiresAdvice` marks an annotation whose methods must be matched by an advisor.
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

Broad pointcuts match methods only, and leave out the Nest lifecycle hooks `onModuleInit`, `onApplicationBootstrap`, `onModuleDestroy`, `beforeApplicationShutdown` and `onApplicationShutdown`. `P.method` selects a lifecycle hook, and `P.kind("getter")` or `P.kind("setter")` selects accessors. A constructor is never a join point.

## Aspects and advice

`@Aspect({ order?, instantiation? })` marks a class as an aspect and as a Nest provider. A lower `order` has higher precedence; an aspect without an order has the lowest. `"singleton"` is the supported instantiation model.

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

- Within one aspect the advice order is around, before, after, after returning, after throwing; advice of the same kind runs in declaration order.
- Advice follows the settlement of a `Promise` result, not the synchronous return. Another thenable, such as a lazy query builder, is followed only when the method is declared asynchronous: an `async` method, or a decorated method whose declared return type is `Promise`. Returned from any other method it reaches the caller untouched and is not run.
- Before, after, after-returning and after-throwing advice can be `async` when the join point is or may be asynchronous. On a join point known to be synchronous, `async` advice is a compile error; where the types cannot tell, it raises `AopUsageError` when called.
- `async` before advice needs a method that is declared asynchronous. A method that returns a promise without being `async` and without a decorated `Promise` return type counts as synchronous for before advice.
- `jp.annotation(A)` is callable only when the pointcut guarantees `A`; `jp.findAnnotation(A)` returns `undefined` when `A` is absent. Both look at the method, then the declaring class, then the target class. Each class step includes inherited class annotations, so for an inherited method an annotation on a superclass of the declaring class wins over one on the target class.
- `jp.args` is frozen. `jp.proceedWith(...args)` runs the rest of the chain with other arguments.
- `jp.proceed()` and `jp.proceedWith(...args)` can be called more than once; each call starts from the arguments the advice received or passes.

The compiler rejects an annotation on a method outside its contract, a missing or mistyped annotation value, around advice with the wrong return type, `proceedWith` arguments that do not fit the method, an after-returning result or after-throwing error parameter of the wrong type, and `P.method` with a name that is not a method of the class. Structurally identical classes are interchangeable to TypeScript, and broad pointcuts such as `P.within` and `P.name` type arguments and results as `unknown`.

## Advisors

`@AopAdvisor()` marks a provider whose instances implement `PointcutAdvisor`: a pointcut, advice and an optional order. The advice is a `MethodInterceptor`.

```ts
import {
  AopAdvisor,
  type MethodInterceptor,
  P,
  type PointcutAdvisor,
} from "nestjs-aspect";

@AopAdvisor()
export class TransactionAdvisor implements PointcutAdvisor {
  constructor(private readonly transactions: TransactionManager) {}

  readonly pointcut = P.annotated(Transactional).or(
    P.withinAnnotated(Transactional),
  );
  readonly advice: MethodInterceptor = {
    invoke: (invocation) => this.transactions.run(() => invocation.proceed()),
  };
  readonly order = 100;
}
```

The entry point also exports the extension interfaces `AdviceAdapter` and `ReturnValueAdapter`, the built-in `promiseAdapter`, and the matching interfaces `PointcutLike`, `ClassFilter`, `MethodMatcher`, `ClassRef` and `MethodRef`.

## Errors

| Class                   | Thrown when                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------- |
| `AopConfigurationError` | Aspects, pointcuts or advice are misconfigured, such as an advice decorator without a pointcut. |
| `AopUsageError`         | Advice is misused at run time, such as asynchronous advice on a synchronous join point.         |
| `AopNotReadyError`      | A woven method is invoked before the instance of an aspect that advises it exists.              |

`instanceof` recognizes these errors across the CommonJS and ES module builds of the package.

## Design

[docs/design.md](https://github.com/thilllon/nestjs-kit/blob/main/packages/nestjs-aspect/docs/design.md) specifies the API, the weaving model and the error behavior. [docs/spring-aop-analysis.md](https://github.com/thilllon/nestjs-kit/blob/main/packages/nestjs-aspect/docs/spring-aop-analysis.md) describes the Spring AOP model and the feature list the design maps to. [docs/sketch/api.ts](https://github.com/thilllon/nestjs-kit/blob/main/packages/nestjs-aspect/docs/sketch/api.ts) holds a type-level sketch of the public API, and [docs/spike](https://github.com/thilllon/nestjs-kit/tree/main/packages/nestjs-aspect/docs/spike) holds runnable experiments on weaving timing.

[Contributing](https://github.com/thilllon/nestjs-kit/blob/main/CONTRIBUTING.md) · [Release setup](https://github.com/thilllon/nestjs-kit/blob/main/docs/releases.md)
