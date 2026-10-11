# nestjs-aspect

[![npm version](https://img.shields.io/npm/v/nestjs-aspect)](https://www.npmjs.com/package/nestjs-aspect)
[![npm monthly downloads](https://img.shields.io/npm/dm/nestjs-aspect)](https://www.npmjs.com/package/nestjs-aspect)
[![CI](https://img.shields.io/github/actions/workflow/status/thilllon/nestjs-kit/ci.yml?branch=main)](https://github.com/thilllon/nestjs-kit/actions/workflows/ci.yml)

**Spring-style aspect-oriented programming for NestJS.** An aspect is a Nest provider that holds a crosscutting concern, such as retries, auditing or transactions, together with pointcuts that select the methods it applies to. `AspectModule` weaves the aspects of an application into every class its container manages.

[Quick start](#quick-start) · [Module options](#aspectmodule) · [Annotations](#annotations) · [Pointcuts](#pointcuts) · [Advice](#advice) · [Ordering](#ordering) · [Asynchronous join points](#asynchronous-join-points) · [Advisors](#advisors) · [Introductions](#introductions) · [Inspection](#inspection) · [Testing](#testing) · [Validation and errors](#bootstrap-validation) · [Limitations](#limitations) · [Spring mapping](#spring-concept-mapping)

## What it is

- **Aspects are providers.** `@Aspect()` marks a class as an aspect and as an injectable provider with regular dependency injection.
- **Pointcuts are independent of the class hierarchy.** A pointcut selects methods by class, name, kind, module, provider token, annotation, Reflect metadata or argument. The advised class does not import the aspect and needs no decorator for it.
- **The five advice kinds of Spring**: `@Before`, `@AfterReturning`, `@AfterThrowing`, `@After` and `@Around`, with the Spring semantics and ordering rules.
- **Typed from the pointcut to the advice.** A pointcut carries the target, argument and return types and the annotations it guarantees; the advice decorators check the advice method against them.
- **Correct for asynchronous code.** Advice follows the settlement of a promise, and of an Observable with the adapter of `nestjs-aspect/rxjs`.
- **Errors instead of silent no-ops.** A misconfiguration fails the bootstrap, and a method whose required advice is missing cannot be called.
- **Every managed class.** Providers, controllers, gateways, guards, interceptors, pipes, filters and middleware, in the singleton, request and transient scopes.

## Installation

```sh
pnpm add nestjs-aspect
```

Requirements:

- **Node.js 24** or later and **NestJS 12**.
- Peer dependencies: `@nestjs/common` and `@nestjs/core` `^12.0.0`, `reflect-metadata` `^0.2.2`, `rxjs` `^7.8.2`.
- Legacy decorators with emitted metadata, as Nest itself requires: `"experimentalDecorators": true` and `"emitDecoratorMetadata": true` in `tsconfig.json`.

The package ships ES module and CommonJS builds with TypeScript declarations. It has two entry points: `nestjs-aspect` and `nestjs-aspect/rxjs`. The types of `nestjs-aspect/rxjs` resolve through the `exports` field of the package, which TypeScript reads with `moduleResolution` `node16`, `nodenext` or `bundler`.

## Quick start

An annotation marks the methods, an aspect holds the behavior, and `AspectModule.forRoot()` weaves the aspect into the application.

```ts
import { Injectable, Module } from "@nestjs/common";
import {
  AfterReturning,
  AfterThrowing,
  Aspect,
  AspectModule,
  Before,
  createAnnotation,
  type JoinPointOf,
  P,
} from "nestjs-aspect";

export const Audited = createAnnotation<"Audited", string>("Audited");

const audited = P.annotated(Audited);

@Injectable()
export class AuditTrail {
  readonly entries: string[] = [];
}

@Aspect()
export class AuditAspect {
  constructor(private readonly trail: AuditTrail) {}

  @Before(audited)
  started(joinPoint: JoinPointOf<typeof audited>): void {
    this.trail.entries.push(
      `${joinPoint.annotation(Audited)}: ${joinPoint.toString()}`,
    );
  }

  @AfterReturning(audited)
  returned(joinPoint: JoinPointOf<typeof audited>, result: unknown): void {
    this.trail.entries.push(
      `${joinPoint.annotation(Audited)} returned ${result}`,
    );
  }

  @AfterThrowing(audited)
  failed(joinPoint: JoinPointOf<typeof audited>, error: unknown): void {
    this.trail.entries.push(
      `${joinPoint.annotation(Audited)} failed: ${error}`,
    );
  }
}

@Injectable()
export class TransferService {
  @Audited("transfer")
  async transfer(from: string, to: string, amount: number): Promise<number> {
    if (amount <= 0) {
      throw new RangeError(`Cannot move ${amount} from ${from} to ${to}`);
    }
    return amount;
  }
}

@Module({
  imports: [AspectModule.forRoot()],
  providers: [TransferService, AuditTrail, AuditAspect],
})
export class AppModule {}
```

`TransferService` knows nothing about `AuditAspect`. The advice runs for every call, and the after-returning and after-throwing advice run when the promise settles:

```ts
const app = await NestFactory.createApplicationContext(AppModule);
const transfers = app.get(TransferService);

await transfers.transfer("alice", "bob", 25);
await transfers.transfer("alice", "bob", 0).catch(() => undefined);

const { entries } = app.get(AuditTrail);
// [
//   'transfer: TransferService.transfer("alice", "bob", 25)',
//   "transfer returned 25",
//   'transfer: TransferService.transfer("alice", "bob", 0)',
//   "transfer failed: RangeError: Cannot move 0 from alice to bob",
// ]
```

A complete HTTP application with a retry aspect and an audit aspect is in [examples/basic](https://github.com/thilllon/nestjs-kit/tree/main/packages/nestjs-aspect/examples/basic).

## AspectModule

Import `AspectModule.forRoot()` once, as the first import of the root module. The module is global. Register aspects and advisors as providers of any module.

Weaving replaces each matched method on its class prototype with a dispatcher that runs the advice of the application the called object belongs to. It happens while Nest instantiates the providers, so advice is in place before the router binds the route handlers and before the first lifecycle hook runs.

| Option                | Default   | Purpose                                                                                                                                                           |
| --------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `returnValueAdapters` | `[]`      | `ReturnValueAdapter`s that let advice follow asynchronous results other than promises, consulted in order before the built-in `promiseAdapter`.                   |
| `adviceAdapters`      | `[]`      | `AdviceAdapter`s that convert the `advice` of an `@Advisor` into a `MethodInterceptor`, which adds advice kinds. Consulted in order before the built-in adapters. |
| `report`              | `"debug"` | Logger level (`"verbose"`, `"debug"` or `"log"`) of the [weaving report](#inspection); `false` logs none.                                                         |
| `strict`              | `true`    | With `true`, the [bootstrap validation](#bootstrap-validation) fails `init()`. With `false`, its findings are warnings and the calls they concern fail instead.   |
| `exclude`             | `[]`      | Classes that are never woven: a class excludes itself and its subclasses, a `ClassFilter` excludes the classes it matches.                                        |

`AspectModule.forRootAsync()` takes the options from a factory, a class or an existing provider:

```ts
import { Injectable, Module } from "@nestjs/common";
import { AspectModule, type AspectReportLevel } from "nestjs-aspect";

@Injectable()
export class Settings {
  readonly aspectReport: AspectReportLevel | false = "log";
}

@Module({
  providers: [Settings],
  exports: [Settings],
})
export class SettingsModule {}

@Module({
  imports: [
    AspectModule.forRootAsync({
      imports: [SettingsModule],
      inject: [Settings],
      useFactory: (settings: Settings) => ({ report: settings.aspectReport }),
    }),
  ],
  providers: [TransferService, AuditTrail, AuditAspect],
})
export class ConfiguredAppModule {}
```

The options come from singleton providers. The weaver waits for them inside the instantiation phase; a provider factory that runs before they are resolved calls its dependencies without advice.

## Annotations

`createAnnotation(name, options?)` creates a typed metadata decorator for methods and classes. Its type parameters are the name literal, the value type and the method contract the annotation accepts.

```ts
import { createAnnotation } from "nestjs-aspect";

export interface RetryOptions {
  attempts: number;
}

export const Retryable = createAnnotation<
  "Retryable",
  RetryOptions,
  (...args: any[]) => Promise<unknown>
>("Retryable", { requiresAdvice: true });

export const Internal = createAnnotation<"Internal">("Internal");
```

`Retryable` takes a `RetryOptions` value and applies only to methods that return a promise; `@Retryable()` without a value or on a synchronous method is a compile error. `Internal` takes no value.

```ts
import { Injectable, Module } from "@nestjs/common";

export class Account {
  constructor(
    readonly id: string,
    public balance = 0,
  ) {}
}

export class DeclinedError extends Error {}

@Injectable()
export class PaymentGateway {
  readonly failures: Error[] = [];

  @Retryable({ attempts: 3 })
  async charge(account: Account, amount: number): Promise<string> {
    const failure = this.failures.shift();
    if (failure) {
      throw failure;
    }
    account.balance -= amount;
    return `receipt-${account.id}-${amount}`;
  }
}

@Injectable()
export class AccountService {
  private readonly accounts = new Map<string, Account>();

  open(id: string): Account {
    const account = new Account(id);
    this.accounts.set(id, account);
    return account;
  }

  find(id: string): Account | undefined {
    return this.accounts.get(id);
  }

  @Internal()
  findAll(): Account[] {
    return [...this.accounts.values()];
  }

  deposit(account: Account, amount: number): Account {
    account.balance += amount;
    return account;
  }
}

@Module({
  providers: [PaymentGateway, AccountService],
  exports: [PaymentGateway, AccountService],
})
export class BillingModule {}
```

- The name is the identity of an annotation: annotations created with the same name read and write the same metadata.
- A method annotation belongs to the method that declares it; an override without the annotation does not carry it. A class annotation is inherited by subclasses. An annotation without a method contract also applies to accessors.
- **`requiresAdvice`** states that an annotated member must be advised by an advisor that handles the annotation: one whose pointcut refers to it with `P.annotated`, `P.withinAnnotated` or `P.targetAnnotated`, in any composition, or whose pointcut comes from `P.matching` or is hand-written. When no such advisor exists, for example because the aspect is not registered, `init()` fails, and in every mode a call of the member raises `AspectConfigurationError` instead of running without the advice. The same holds after the application has closed or has failed to initialize: on an instance its container created, the call of a member that requires advice raises `AspectConfigurationError`.
- `isAnnotation(value)` tells an annotation from other functions.
- Decorators created with Nest's `Reflector.createDecorator()` are accepted by `P.annotated`, `P.withinAnnotated`, `P.targetAnnotated` and `joinPoint.findAnnotation`.

## Pointcuts

`P` builds typed pointcuts. A pointcut is a value: export it as a constant and share it between aspects.

| Designator                                   | Spring equivalent             | Matches                                                                                                         |
| -------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `P.method(Type, "name")`                     | `execution(* Type+.name(..))` | That method of `Type` and its subclasses. Carries its exact signature. The only designator for lifecycle hooks. |
| `P.within(...Types)`                         | `within(Type)`                | Members declared on one of the classes.                                                                         |
| `P.target(Type)`                             | `target(Type)`, `this(Type)`  | Members of `Type` and its subclasses.                                                                           |
| `P.name("find*" \| /^find/)`                 | Name pattern of `execution`   | Members by name; `*` in a string matches any run of characters.                                                 |
| `P.kind("method" \| "getter" \| "setter")`   | -                             | Members by kind. The only designator for accessors.                                                             |
| `P.annotated(A)`                             | `@annotation(A)`              | Members that carry `A`. Carries the method contract of `A` and guarantees `A`.                                  |
| `P.withinAnnotated(A)`                       | `@within(A)`                  | Members declared on a class that carries `A`.                                                                   |
| `P.targetAnnotated(A)`                       | `@target(A)`                  | Members of a class that carries `A`.                                                                            |
| `P.args(Account, P.ANY, P.REST)`             | `args(Account, *, ..)`        | Calls by their arguments, checked on every call. Types `joinPoint.args`.                                        |
| `P.bean("token*" \| /Service$/ \| Type)`     | `bean(name*)`                 | Classes registered under a matching provider token.                                                             |
| `P.inModule(Module, { transitive })`         | `within(package..*)`          | Providers and controllers a Nest module declares; with `transitive`, also those of the modules it imports.      |
| `P.metadata(key, predicate?)`                | Attribute-driven pointcut     | Members with Reflect metadata `key`, such as metadata stored by `SetMetadata`.                                  |
| `P.matching({ classFilter, methodMatcher })` | Custom `Pointcut`             | Members a hand-written class filter and method matcher accept.                                                  |

Compose pointcuts with `.and()`, `.or()` and `.not()`, or fold a list with `P.all(...)` and `P.any(...)`.

```ts
import { P } from "nestjs-aspect";

export const retryable = P.annotated(Retryable);
export const charge = P.method(PaymentGateway, "charge");
export const inBilling = P.inModule(BillingModule);
export const queries = inBilling
  .and(P.name("find*"))
  .and(P.annotated(Internal).not());
export const deposits = P.within(AccountService).and(P.args(Account, Number));
```

- **Types.** `charge` carries the signature of `PaymentGateway.charge`, `retryable` the method contract and the value type of `Retryable`, and `deposits` types `joinPoint.args` as `[Account, number]`. `and` guarantees the annotations of both sides, `or` those common to both, `not` none. Broad pointcuts such as `P.within` and `P.name` type arguments and results as `unknown`.
- **Default join points.** Broad pointcuts match methods only, and leave out the Nest lifecycle hooks `onModuleInit`, `onApplicationBootstrap`, `onModuleDestroy`, `beforeApplicationShutdown` and `onApplicationShutdown`. `P.method` selects a lifecycle hook, and `P.kind("getter")` or `P.kind("setter")` selects accessors. A constructor is never a join point.
- **Static and dynamic matching.** Every designator except `P.args` is evaluated once per class member when the class is woven. `P.args` is evaluated on every call of a member the rest of the pointcut matches; combine it with a static designator. In `P.args`, a class matches an argument that is `instanceof` it, `String`, `Number`, `Boolean`, `BigInt` and `Symbol` match their primitives, `P.ANY` matches one argument and `P.REST` the remaining ones.
- **`P.bean`** matches a class when one of its registrations has a matching token, `useClass` tokens included. A `useExisting` token and the instance of a singleton `useFactory` or `useValue` provider are matched when the application initializes, and the instance of a request-scoped or transient `useFactory` provider when the container first resolves one. `P.bean` selects the class: its advice then applies to every instance of that class.
- **`P.inModule(Module, { transitive: true })`** follows the imports of the module. A global module counts only when the `@Module()` decorator of the importing module lists it.

## Advice

`@Aspect({ order?, instantiation? })` marks a class as an aspect and as a Nest provider; list it in the `providers` of a module. Each advice decorator takes a pointcut and checks the signature of the method it decorates against it. `JoinPointOf<typeof pointcut>` and `ProceedingJoinPointOf<typeof pointcut>` are the join point types of a pointcut.

| Decorator                                 | Advice signature                                                                | Semantics                                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `@Before(pointcut)`                       | `(joinPoint: JoinPointOf<typeof pointcut>)`                                     | Runs before the join point. An error prevents the join point and propagates.                                        |
| `@AfterReturning(pointcut)`               | `(joinPoint: JoinPointOf<typeof pointcut>, result)`                             | Runs after a normal completion with the result. It cannot replace the result.                                       |
| `@AfterThrowing(pointcut, { throwing? })` | `(joinPoint: JoinPointOf<typeof pointcut>, error)`                              | Runs when the join point fails, with `throwing` only for errors of that class. The error propagates afterwards.     |
| `@After(pointcut)`                        | `(joinPoint: JoinPointOf<typeof pointcut>)`                                     | Runs after the join point, whatever its outcome.                                                                    |
| `@Around(pointcut)`                       | `(joinPoint: ProceedingJoinPointOf<typeof pointcut>)` returning the result type | Surrounds the join point: it decides whether and how often the join point runs, and its return value is the result. |

Use the least powerful advice that does the job: an after-returning advice cannot forget to call `proceed()`.

### Before

Before advice runs ahead of the join point and can prevent it only by throwing. `deposits` contains `P.args(Account, Number)`, so the advice runs for the calls whose arguments match, and `joinPoint.args` is typed.

```ts
import { Aspect, Before, type JoinPointOf } from "nestjs-aspect";

@Aspect()
export class DepositLimitAspect {
  @Before(deposits)
  check(joinPoint: JoinPointOf<typeof deposits>): void {
    const [account, amount] = joinPoint.args;
    if (amount <= 0) {
      throw new RangeError(`Cannot deposit ${amount} into ${account.id}`);
    }
  }
}
```

### After returning

After-returning advice receives the result of a normal completion: for a method that returns a promise, the value the promise resolves to. Its second parameter is typed from the pointcut. An error the advice throws propagates instead of the result.

```ts
import { Injectable } from "@nestjs/common";
import { AfterReturning, Aspect, type JoinPointOf } from "nestjs-aspect";

@Injectable()
export class Ledger {
  readonly lines: string[] = [];
}

@Aspect()
export class ReceiptAspect {
  constructor(private readonly ledger: Ledger) {}

  @AfterReturning(charge)
  record(joinPoint: JoinPointOf<typeof charge>, receipt: string): void {
    const [account, amount] = joinPoint.args;
    this.ledger.lines.push(`${receipt}: ${amount} from ${account.id}`);
  }
}
```

### After throwing

After-throwing advice receives the error of the join point: a thrown error or the rejection of its promise. With `throwing`, it runs only for errors that are `instanceof` that class. The same error propagates after the advice; an error the advice throws replaces it. It is not a catch block: the caller still receives the error.

```ts
import { AfterThrowing, Aspect, type JoinPointOf } from "nestjs-aspect";

@Aspect()
export class DeclineAspect {
  constructor(private readonly ledger: Ledger) {}

  @AfterThrowing(charge, { throwing: DeclinedError })
  record(joinPoint: JoinPointOf<typeof charge>, error: DeclinedError): void {
    this.ledger.lines.push(
      `declined ${joinPoint.args[0].id}: ${error.message}`,
    );
  }
}
```

### After

After advice runs when the join point has finished, whether it returned or failed, like a `finally` block. For an asynchronous join point it runs when the promise settles. An error the advice throws replaces the outcome.

```ts
import { After, Aspect, Before } from "nestjs-aspect";

@Aspect()
export class InFlightAspect {
  inFlight = 0;

  @Before(charge)
  enter(): void {
    this.inFlight += 1;
  }

  @After(charge)
  leave(): void {
    this.inFlight -= 1;
  }
}
```

### Around

Around advice surrounds the join point. `joinPoint.proceed()` runs the rest of the chain and the join point, and can be called zero times, once or several times; `joinPoint.proceedWith(...args)` runs it with other arguments. The value the advice returns is the result of the call. `retryable` guarantees the `Retryable` annotation, so `joinPoint.annotation(Retryable)` is typed as `RetryOptions`.

```ts
import { Around, Aspect, type ProceedingJoinPointOf } from "nestjs-aspect";

@Aspect({ order: 20 })
export class RetryAspect {
  @Around(retryable)
  async retry(
    joinPoint: ProceedingJoinPointOf<typeof retryable>,
  ): Promise<unknown> {
    const { attempts } = joinPoint.annotation(Retryable);
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await joinPoint.proceed();
      } catch (error) {
        if (error instanceof DeclinedError || attempt >= attempts) {
          throw error;
        }
      }
    }
  }
}
```

### The join point

| Member                                                  | Meaning                                                                                                       |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `joinPoint.target`                                      | The object the member is called on.                                                                           |
| `joinPoint.args`                                        | The arguments, frozen. `proceedWith` runs the join point with other arguments.                                |
| `joinPoint.signature`                                   | `name`, `declaringType` (the class that defines the member) and `targetType` (the woven class).               |
| `joinPoint.kind`                                        | `"method"`, `"getter"` or `"setter"`.                                                                         |
| `joinPoint.isAsync`                                     | True for an `async` method and for a decorated method whose declared return type is `Promise`.                |
| `joinPoint.annotation(A)`                               | The value of an annotation the pointcut guarantees. A compile error when the pointcut does not guarantee `A`. |
| `joinPoint.findAnnotation(A)`                           | The value of an annotation, or `undefined` when it is absent.                                                 |
| `joinPoint.introduced(Token)`                           | The delegate of an [introduction](#introductions) for the target.                                             |
| `joinPoint.toString()`                                  | `'TransferService.transfer("alice", "bob", 25)'`.                                                             |
| `joinPoint.proceed()`, `joinPoint.proceedWith(...args)` | Around advice only.                                                                                           |

Annotation lookups read the method, then the declaring class, then the target class.

The compiler rejects an annotation on a method outside its contract, a missing or mistyped annotation value, around advice with the wrong return type, `proceedWith` arguments that do not fit the method, an after-returning result or after-throwing error parameter of the wrong type, asynchronous advice on a join point known to be synchronous, and `P.method` with a name that is not a method of the class.

## Ordering

- **Across aspects and advisors**, a lower `order` has the higher precedence: its advice runs first on the way in and last on the way out. One without an order has the lowest precedence. Aspects with equal orders, or without one, nest in registration order: the one registered first is the outer one. The weaver reports this as a warning when they advise the same member.
- **Within one aspect**, the advice kinds nest in this order from the outside in: around, before, after, after returning, after throwing. After advice therefore runs after the after-returning and after-throwing advice of its aspect. Advice of the same kind nests in declaration order: the first declared is the outermost, so before advice runs in declaration order, and after, after-returning and after-throwing advice in reverse declaration order.

```ts
import {
  After,
  AfterReturning,
  Around,
  Aspect,
  Before,
  type ProceedingJoinPointOf,
} from "nestjs-aspect";

export const trace: string[] = [];

@Aspect({ order: 1 })
export class OuterAspect {
  @Around(charge)
  async around(
    joinPoint: ProceedingJoinPointOf<typeof charge>,
  ): Promise<string> {
    trace.push("outer around: before proceed");
    const receipt = await joinPoint.proceed();
    trace.push("outer around: after proceed");
    return receipt;
  }

  @Before(charge)
  before(): void {
    trace.push("outer before");
  }

  @After(charge)
  after(): void {
    trace.push("outer after");
  }

  @AfterReturning(charge)
  afterReturning(): void {
    trace.push("outer after returning");
  }
}

@Aspect({ order: 2 })
export class InnerAspect {
  @Before(charge)
  before(): void {
    trace.push("inner before");
  }

  @AfterReturning(charge)
  afterReturning(): void {
    trace.push("inner after returning");
  }
}
```

One call of `PaymentGateway.charge` leaves this trace:

```
outer around: before proceed
outer before
inner before
inner after returning
outer after returning
outer after
outer around: after proceed
```

## Asynchronous join points

- **Promises.** After-returning, after-throwing and after advice follow the settlement of a `Promise`, not the synchronous return of the promise object.
- **Asynchronous advice.** Before, after, after-returning and after-throwing advice can be `async` when the join point is or may be asynchronous; the settlement the caller sees waits for the advice. On a join point known to be synchronous, `async` advice is a compile error; where the types cannot tell, it raises `AspectUsageError` when called.
- **Asynchronous before advice** needs a method that is declared asynchronous: an `async` method, or a decorated method whose declared return type is `Promise`. A method that returns a promise without either counts as synchronous for before advice.
- **Other thenables**, such as a lazy query builder, are followed only when the method is declared asynchronous. Returned from any other method they reach the caller untouched and are not run.
- **Around advice** receives what `proceed()` returns, a promise for an asynchronous method, and awaits it when it needs the result.

### Observables

`observableAdapter` of the `nestjs-aspect/rxjs` entry lets advice follow an Observable. Register it in `returnValueAdapters`. The root entry does not load `rxjs`.

```ts
import { Injectable, Module } from "@nestjs/common";
import {
  AfterReturning,
  Aspect,
  AspectModule,
  type JoinPointOf,
  P,
} from "nestjs-aspect";
import { observableAdapter } from "nestjs-aspect/rxjs";
import { type Observable, of } from "rxjs";

@Injectable()
export class PriceFeed {
  quotes(symbol: string): Observable<number> {
    return symbol === "ACME" ? of(101, 102, 103) : of();
  }
}

export const quotes = P.method(PriceFeed, "quotes");

@Aspect()
export class ClosingPriceAspect {
  readonly closing = new Map<string, number>();

  @AfterReturning(quotes)
  record(joinPoint: JoinPointOf<typeof quotes>, last: number): void {
    this.closing.set(joinPoint.args[0], last);
  }
}

@Module({
  imports: [AspectModule.forRoot({ returnValueAdapters: [observableAdapter] })],
  providers: [PriceFeed, ClosingPriceAspect],
})
export class FeedModule {}
```

An Observable is lazy, so the advice runs within each subscription:

- After-returning advice runs when the stream completes, with the last value it emitted or `undefined` when it emitted none. For a method that returns an Observable, the result parameter is typed `any`, so the advice declares the type of the emitted values itself.
- After-throwing advice runs on the error notification.
- After advice runs once when the subscription ends: at completion, at an error, or when the subscriber unsubscribes.
- A result that is never subscribed runs no after advice; a result that is subscribed twice runs it twice.
- Before advice and the code of around advice run when the method is called, not at subscription.

A custom `ReturnValueAdapter` (`supports`, `onSuccess`, `onError`, `finally`) makes advice follow another result type.

## Scopes, self-invocation and the request pipeline

- **Targets of every scope are advised**: singleton, request-scoped and transient.
- **Aspects and advisors are singletons.** One that is request-scoped or transient, by its own scope or because it depends on a request-scoped provider, is rejected when the application initializes. Per-request state belongs to the join point: resolve a request-scoped provider inside the advice with `ModuleRef.resolve()` and `ContextIdFactory`, or read it from a CLS store.
- **Aspects and advisors are never advised.** An aspect inherits the advice of a superclass without `@Aspect`; an aspect that extends another `@Aspect` class is rejected.
- **Self-invocation is advised.** A call from a method to another method of the same object (`this.other()`) runs the advice of that method, unlike in Spring: the dispatcher is the member on the class prototype, not a proxy in front of the object.
- **Controllers.** On a route handler, advice runs inside the Nest interceptors and after the pipes, so it sees the transformed arguments:

  ```
  middleware -> guards -> interceptors -> pipes -> [ advice -> route handler ] -> interceptors -> exception filters
  ```

  An error thrown by advice reaches the exception filters like an error of the handler. Route metadata and `SetMetadata` values stay visible on a woven handler.

## Advisors

`@Advisor()` marks a provider as an advisor: one pointcut and one advice, the layer aspects compile to. The static member `pointcut` selects the join points; an instance supplies `advice`, a `MethodInterceptor`, and an optional `order`.

```ts
import { Injectable } from "@nestjs/common";
import {
  Advisor,
  createAnnotation,
  type MethodInterceptor,
  P,
} from "nestjs-aspect";

export const Transactional = createAnnotation<"Transactional">("Transactional");

@Injectable()
export class TransactionManager {
  readonly log: string[] = [];

  async run(work: () => unknown): Promise<unknown> {
    this.log.push("begin");
    try {
      const result = await work();
      this.log.push("commit");
      return result;
    } catch (error) {
      this.log.push("rollback");
      throw error;
    }
  }
}

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

@Injectable()
@Transactional()
export class InvoiceService {
  async issue(account: Account, amount: number): Promise<string> {
    if (amount <= 0) {
      throw new RangeError(`Cannot invoice ${amount}`);
    }
    return `invoice-${account.id}-${amount}`;
  }
}
```

- The pointcut is static because the weaver matches it before Nest creates the advisor instance. `@Advisor()` on a class without a static `pointcut` is a compile error and raises `AspectConfigurationError`.
- `invocation.proceed()` runs the rest of the chain once. An interceptor that proceeds more than once uses `invocation.cloneFromHere(args?)` for each run. `invocation.method`, `invocation.target`, `invocation.args` and `invocation.joinPoint` describe the call.
- An `AdviceAdapter` in the `adviceAdapters` option converts another kind of `advice` object into a `MethodInterceptor`; `context.returnValues` gives it the return value adapters of the application.
- The entry point also exports the matching interfaces `PointcutAdvisor`, `PointcutLike`, `ClassFilter`, `MethodMatcher`, `ClassRef` and `MethodRef`.

## Instantiation models

`@Aspect({ instantiation })` selects how many instances of an aspect serve its advice.

| Model         | Instances                                                                                  | Spring equivalent      |
| ------------- | ------------------------------------------------------------------------------------------ | ---------------------- |
| `"singleton"` | The provider instance. The default.                                                        | singleton              |
| `"perTarget"` | One per target object, created at the first advised call on it, collected with the object. | `perthis`, `pertarget` |
| `"perClass"`  | One per advised class.                                                                     | `pertypewithin`        |

```ts
import { Injectable, Scope } from "@nestjs/common";
import { Aspect, Before, P } from "nestjs-aspect";

@Injectable({ scope: Scope.TRANSIENT })
export class Session {
  touch(): string {
    return "touched";
  }
}

const sessions = P.within(Session);

@Aspect({ instantiation: "perTarget" })
export class CallCountAspect {
  private calls = 0;

  constructor(private readonly ledger: Ledger) {}

  @Before(sessions)
  count(): void {
    this.calls += 1;
    this.ledger.lines.push(`call ${this.calls} of this session`);
  }
}
```

An instance of a `perTarget` or `perClass` aspect is created during a call, with the singleton providers its constructor and `@Inject()` properties name. A dependency that is request-scoped, transient or missing is rejected when the application initializes.

## Introductions

`@DeclareParents` declares that the classes a pointcut or class filter selects implement another interface, and names the class that implements it. The decorator applies to a static member of an aspect whose type is the interface: an abstract class, because a TypeScript interface leaves no value at run time.

```ts
import {
  Aspect,
  Before,
  DeclareParents,
  type JoinPointOf,
} from "nestjs-aspect";

export abstract class UsageTracked {
  abstract incrementUseCount(): void;

  abstract get useCount(): number;
}

export class DefaultUsageTracked implements UsageTracked {
  private count = 0;

  incrementUseCount(): void {
    this.count += 1;
  }

  get useCount(): number {
    return this.count;
  }
}

@Aspect()
export class UsageTrackingAspect {
  @DeclareParents(sessions, { use: DefaultUsageTracked })
  static readonly mixin: UsageTracked;

  @Before(sessions)
  record(joinPoint: JoinPointOf<typeof sessions>): void {
    joinPoint.introduced(UsageTracked).incrementUseCount();
  }
}
```

The methods and accessors of `DefaultUsageTracked` become members of every `Session`. Each object has its own delegate, created without arguments on first use. `isIntroduced` narrows an object to the introduced interface, and `introduced(object, Token)` returns the delegate:

```ts
const session = await app.resolve(Session);
session.touch();
session.touch();
const uses = isIntroduced(session, UsageTracked) ? session.useCount : 0;
```

- An introduction applies to whole classes: of a pointcut, only the class filter is used.
- A member the class already has, or that another introduction adds, raises `AspectConfigurationError` while the module compiles, unless the introduction sets `override: true`.
- Introduced members are not advised.

## Inspection

`AspectInspector` is a provider `AspectModule` exports globally. It lists what the application advises.

```ts
const inspector = app.get(AspectInspector);
const advisors = inspector.advisorsOf(PaymentGateway, "charge");
const members = inspector.advisedMembers(PaymentGateway);
```

- `advisorsOf(type, name, kind?)` returns the advisors of one member in the order their advice runs: `{ type, methodName?, kind?, order }`, where `type` is the aspect or advisor class. With `RetryAspect` and `ReceiptAspect` registered, `advisors` holds `RetryAspect.retry` (around, order 20) and then `ReceiptAspect.record` (afterReturning, no order).
- `advisedMembers(type?)` returns every advised member of the application or of one class: `{ type, declaringType, name, kind, advisors }`.
- It reports static matches: an advisor with `P.args` is listed for every member it may advise. It lists nothing after the application has shut down.

When the application initializes, the weaver logs the same information as the **weaving report** through the Nest `Logger`, with the context `AspectModule` and at the level of the `report` option. One line names a member and one advisor, in chain order:

```
TransferService.transfer <- AuditAspect.started (before, no order)
TransferService.transfer <- AuditAspect.returned (afterReturning, no order)
TransferService.transfer <- AuditAspect.failed (afterThrowing, no order)
```

## Testing

Weaving happens while the module compiles, so advice runs after `compile()` without `init()`. The bootstrap validation, the weaving report and the weaving of factory and value provider instances run in `init()`.

```ts
const moduleRef = await Test.createTestingModule({
  imports: [AppModule],
}).compile();

await moduleRef.get(TransferService).transfer("alice", "bob", 25);
const { entries } = moduleRef.get(AuditTrail);
await moduleRef.close();
```

Close each application or testing module: `close()` detaches it from the woven classes. An object created with `new` runs its original methods when no live application advises its class:

```ts
const unmanaged = new TransferService();
await unmanaged.transfer("alice", "bob", 25);
```

- **Unmanaged instances.** While exactly one live application advises a class, an object of that class created with `new` is advised by that application.
- **Several applications in one process** stay apart. An instance is advised by the application whose container created it, also when that application excludes the class or matches nothing in it, and an instance of a closed application is not advised by a later one. An object that a container only holds, as the instance of a `useValue` or `useFactory` provider, belongs to that application while the application advises its class.
- **Ambiguous objects.** When several live applications advise a class and nothing tells which of them an object belongs to, as for an object created with `new`, a call raises `AspectUsageError`. With `strict: false` in each of those applications, the most recently created one advises the object and logs a warning. An application that is never closed stays live as long as one of its instances is reachable, so close the modules of earlier tests.
- **Replaced aspects.** An aspect replaced with `overrideProvider(...).useValue(...)` is no aspect any more: its advice does not run.

## Bootstrap validation

`AspectModule` validates the configuration in its `onModuleInit` hook and raises the findings of one application as one `AspectConfigurationError`. `LazyModuleLoader.load()` validates the classes of the modules it loaded in the same way and rejects with that error.

| Finding                                                                                   | `strict: true`               | `strict: false`                                  |
| ----------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------ |
| Advice decorators on a class without `@Aspect`                                            | Error                        | Error                                            |
| An aspect or advisor supplied by a factory, value or alias provider                       | Error                        | Error                                            |
| An aspect or advisor that is not a singleton                                              | Error                        | Warning; its advice raises `AspectNotReadyError` |
| A `perTarget` or `perClass` aspect with a dependency that is no singleton provider        | Error                        | Warning; the call fails                          |
| An advisor instance without `advice` or with an `order` that is no number                 | Error                        | Warning; the call fails                          |
| A `requiresAdvice` annotation on a member no advisor handles, or on a class never advised | Error that lists the members | Warning; the call fails                          |
| A pointcut that matches no member of the application                                      | Warning                      | Warning                                          |
| Different aspects with the same order, or without one, on one member                      | Warning                      | Warning                                          |
| An aspect or advisor class registered in several modules                                  | Warning                      | Warning                                          |
| A global module with a shutdown hook imported before `AspectModule`                       | Warning                      | Warning                                          |

Independent of `strict`, `compile()` fails when `AspectModule` is registered more than once, when an aspect extends another `@Aspect` class and when an introduction collides with a member; `init()` fails when the `forRootAsync` options depend on a request-scoped or transient provider.

### Errors

| Class                      | Thrown when                                                                                                                                           |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AspectConfigurationError` | Aspects, pointcuts, advice or module options are misconfigured, a bootstrap validation fails, or a member is called whose required advice is missing. |
| `AspectUsageError`         | Advice is misused at run time: asynchronous advice on a synchronous join point, an introduction that is not declared, an ambiguous object.            |
| `AspectNotReadyError`      | A woven member is called before the instance of an aspect or advisor that advises it exists.                                                          |

`instanceof` recognizes these errors across the CommonJS and ES module builds of the package.

## Limitations

- **Calls during instantiation.** A call made while Nest instantiates providers, in a constructor or a provider factory, is not guaranteed to be advised. Before the weaver has run it runs without advice; after that, a call that reaches a woven member before the instance of its aspect or advisor exists raises `AspectNotReadyError`.
- **Import order.** With a global module imported before `AspectModule`, the `onApplicationShutdown` hooks of that module run after `AspectModule` has shut down, without advice; a member that requires advice rejects the call.
- **Middleware.** A middleware class that is only passed to `consumer.apply()` becomes known when the application initializes, after the router has bound its `use` method: `use` itself is not advised, the methods it calls are. Register the middleware as a provider as well to have `use` advised.
- **Factory and value providers.** A singleton factory or value provider is woven by the class of its instance when the application initializes; the instance of a request-scoped or transient factory provider when the container first resolves one. A pointcut that matches only such instances is reported as matching nothing when the application initializes.
- **Aspects are class providers.** An aspect or advisor that a `useFactory`, `useValue` or `useExisting` provider supplies is rejected.
- **Lazy-loaded modules.** The classes of a module loaded with `LazyModuleLoader` are woven when `load()` resolves, after their instances exist: a call that a constructor of such a module makes is not advised. An aspect or advisor in a lazy-loaded module is rejected; register aspects in a module the application loads at bootstrap.
- **Object identity.** An application recognizes its instances by identity. A `Proxy` around an instance, or an object created with `Object.create(instance)`, counts as an object no container created: the live applications that advise its class advise it, also when the application of the wrapped instance excludes the class or matches nothing in it.
- **`requiresAdvice` outside an application.** The rule protects the objects of an application. On an object created with `new`, a member that requires advice runs without it while no live application advises the class.
- **Applications without a handle.** An application stays live while one of its instances is reachable. An instance that leaves its constructor through a side channel, and is neither injected, resolved nor called before the last reference to the application is dropped, does not keep it live.
- **Not join points**: arrow-function class fields, `#private` methods, constructors, introduced members, and the members of aspects, advisors, module classes and excluded classes.
- **Subclasses.** A subclass the container manages that matches no advisor is not advised through the dispatcher it inherits from a woven superclass; a `super` call from an override is advised when the superclass is woven.
- **No type patterns.** A pointcut cannot match by return type or parameter type; `P.method`, `P.args` and annotation contracts carry types.
- **An application without `AspectModule`** is invisible to the others: while another live application advises a class, the instances of that class in the application without the module are advised by it.
- **Observables.** Advice that runs because a subscriber unsubscribes is not awaited.
- The advice of a running application cannot be changed.

## Spring concept mapping

| Spring                                                              | nestjs-aspect                                                            |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `@EnableAspectJAutoProxy`                                           | `AspectModule.forRoot()` / `forRootAsync()`                              |
| `@Aspect` with `@Component`                                         | `@Aspect()` in the `providers` of a module                               |
| `@Pointcut` method                                                  | An exported constant built with `P`                                      |
| AspectJ pointcut expression, `&&`, `\|\|`, `!`                      | `P` designators, `.and()`, `.or()`, `.not()`                             |
| `@Before`, `@AfterReturning`, `@AfterThrowing`, `@After`, `@Around` | The same names                                                           |
| `returning`, `throwing`                                             | The second advice parameter; `{ throwing: ErrorClass }`                  |
| `JoinPoint`, `ProceedingJoinPoint`                                  | `JoinPointOf<typeof pointcut>`, `ProceedingJoinPointOf<typeof pointcut>` |
| `proceed()`, `proceed(args)`                                        | `joinPoint.proceed()`, `joinPoint.proceedWith(...args)`                  |
| `args(..)` and `@annotation(..)` binding                            | `joinPoint.args`, `joinPoint.annotation(A)`, typed by the pointcut       |
| Java annotation                                                     | `createAnnotation()`, or `Reflector.createDecorator()`                   |
| `@Order`, `Ordered`                                                 | `@Aspect({ order })`, `order` of an advisor                              |
| `perthis`, `pertarget`, `pertypewithin`                             | `instantiation: "perTarget"`, `"perClass"`                               |
| `@DeclareParents`                                                   | `@DeclareParents`, `isIntroduced`, `introduced`, `joinPoint.introduced`  |
| `Advisor`, `MethodInterceptor`, `MethodInvocation`                  | `@Advisor()`, `MethodInterceptor`, `MethodInvocation`                    |
| `Pointcut`, `ClassFilter`, `MethodMatcher`                          | `PointcutLike`, `ClassFilter`, `MethodMatcher`                           |
| `AdvisorAdapterRegistry`                                            | `AdviceAdapter`, the `adviceAdapters` option                             |
| `ReactiveAdapterRegistry`                                           | `ReturnValueAdapter`, the `returnValueAdapters` option                   |
| `Advised`                                                           | `AspectInspector` (read-only)                                            |
| `AopContext.currentProxy()`                                         | Not needed: self-invocation is advised                                   |
| `bean(name*)`                                                       | `P.bean()`                                                               |
| Package                                                             | Nest module: `P.inModule()`                                              |

## Design

[docs/design.md](https://github.com/thilllon/nestjs-kit/blob/main/packages/nestjs-aspect/docs/design.md) explains aspect-oriented programming and the Spring AOP model, and specifies the weaving strategy, the run-time semantics, the differences from Spring and the coverage of the Spring feature list. [examples/basic](https://github.com/thilllon/nestjs-kit/tree/main/packages/nestjs-aspect/examples/basic) is a runnable application.

[Contributing](https://github.com/thilllon/nestjs-kit/blob/main/CONTRIBUTING.md) · [Release setup](https://github.com/thilllon/nestjs-kit/blob/main/docs/releases.md)
