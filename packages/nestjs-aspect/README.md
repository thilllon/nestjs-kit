# nestjs-aspect

[![npm version](https://img.shields.io/npm/v/nestjs-aspect)](https://www.npmjs.com/package/nestjs-aspect)
[![npm monthly downloads](https://img.shields.io/npm/dm/nestjs-aspect)](https://www.npmjs.com/package/nestjs-aspect)
[![CI](https://img.shields.io/github/actions/workflow/status/thilllon/nestjs-kit/ci.yml?branch=main)](https://github.com/thilllon/nestjs-kit/actions/workflows/ci.yml)

**Spring-style aspect-oriented programming for NestJS.** An aspect is a Nest provider that holds a crosscutting concern, such as retries, auditing or transactions, together with pointcuts that select the methods it applies to. `AspectModule` weaves the aspects of an application into every class its container manages.

[Aspect or enhancer](#when-to-use-an-aspect) · [Quick start](#quick-start) · [Annotations](#annotations) · [Pointcuts](#pointcuts) · [Advice](#advice) · [Recipes](#recipes) · [Module options](#aspectmodule) · [Ordering](#ordering) · [Asynchronous join points](#asynchronous-join-points) · [Advisors](#advisors) · [Introductions](#introductions) · [Inspection](#inspection) · [Testing](#testing) · [Validation and errors](#bootstrap-validation) · [Limitations](#limitations) · [Spring mapping](#spring-concept-mapping)

## What it is

- **Aspects are providers.** An aspect is a class that holds one behavior shared by many methods, such as a transaction or a retry, apart from the classes that use it. `@Aspect()` marks a class as an aspect and as an injectable provider with regular dependency injection.
- **Pointcuts are independent of the class hierarchy.** A join point is one call of a method, or of an accessor, of a class the Nest container manages, and a pointcut is a value that selects join points. A pointcut selects methods by class, name, kind, module, provider token, annotation, Reflect metadata or argument; an annotation is a typed decorator that marks a method or a class for a pointcut and can carry a value. The advised class does not import the aspect and needs no decorator for it.
- **Five kinds of advice.** Advice is a method of an aspect that runs at the join points a pointcut selects: before the call, after it returns, after it throws, after either outcome, or around it. The decorators are `@Before`, `@AfterReturning`, `@AfterThrowing`, `@After` and `@Around`, with the semantics and the ordering rules of Spring AOP.
- **Typed from the pointcut to the advice.** A pointcut carries the target, argument and return types and the annotations it guarantees; the advice decorators check the advice method against them.
- **Correct for asynchronous code.** Advice follows the settlement of a promise, and of an Observable with the adapter of `nestjs-aspect/rxjs`.
- **Errors instead of silent no-ops.** A misconfiguration fails the bootstrap, and a method whose required advice is missing cannot be called.
- **Every managed class.** `AspectModule` weaves the aspects: it installs the advice on the selected methods while Nest instantiates the classes, and a method with advice is an advised method. Weaving covers providers, controllers, gateways, guards, interceptors, pipes, filters and middleware, in the singleton, request and transient scopes.

## When to use an aspect

Nest runs guards, pipes, interceptors and exception filters around the handlers it dispatches to: HTTP route handlers, microservice message handlers, WebSocket gateway handlers and GraphQL resolvers. They receive the `ExecutionContext` with the request and the response, and they remain the right tool for the request pipeline. Advice sees a method call, its arguments and its outcome, not the request. This package is for the calls that enhancers do not reach.

| Concern                                                                                                                        | Tool             |
| ------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| Authentication and authorization of a handler                                                                                  | Guard            |
| Validation and transformation of the arguments of a handler                                                                    | Pipe             |
| Logging, timing, a timeout, response mapping or response caching (`CacheInterceptor`) of a handler                             | Interceptor      |
| Mapping an error to a response                                                                                                 | Exception filter |
| Behavior around a call from one provider to another: service to service, service to repository, a client of a remote system    | Aspect           |
| Behavior around a method that no handler dispatch reaches: one that a timer, a job worker, an event emitter or a command calls | Aspect           |
| One behavior for many methods selected by module, class, name or provider token, without a decorator on each of them           | Aspect           |

- **An enhancer binds to a handler.** `@UseGuards()`, `@UseInterceptors()`, `@UsePipes()` and `@UseFilters()` on a method that Nest does not dispatch to as a handler have no effect, unless an integration runs the enhancer chain around it with `ExternalContextCreator`. A global enhancer applies to every handler, not to every provider.
- **An interceptor surrounds the handler as a whole.** It cannot delimit a transaction at one service method or retry one call of a remote client.
- **A call that starts outside a handler has no enhancer chain.** An error a job throws reaches no exception filter.
- **Advice has no `ExecutionContext`.** A concern that reads the request, sets a response header or depends on the route belongs in an enhancer. On a route handler both apply: [advice runs inside the interceptors](#scopes-self-invocation-and-the-request-pipeline).

Behind the handlers, two plain techniques cover a provider method without this package:

- **An explicit call through an injected dependency** inside the method, such as `this.database.transactional(() => ...)` or `wrap(key, () => ...)` of the cache that `@nestjs/cache-manager` provides. It works for every provider method, in a request and outside one, and is the simpler choice for one or two call sites.
- **A TypeScript method decorator** that replaces `descriptor.value` with a wrapper. It needs no library, but it runs when the class is defined, outside the container: it cannot inject a provider and reaches one only through global or static state.

An aspect adds four things to them. When a concern needs none of the four, use the explicit call.

- Advice is a provider: it injects the database client, the error reporter or the configuration it works with.
- A pointcut selects methods without touching them, the methods of classes written later included.
- Several concerns on one method run in a [defined order](#ordering).
- `requiresAdvice` fails the bootstrap when the behavior an annotation promises is not registered.

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

An annotation marks the methods, an aspect holds the behavior, and `AspectModule.forRoot()` weaves the aspect into the application. `Pointcut` is the namespace of the pointcut designators, the functions that build pointcuts; the examples import it as `P` for brevity.

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
  Pointcut as P,
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
import { NestFactory } from "@nestjs/core";

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

Import `AspectModule.forRoot()` once, as the first import of the root module; [AspectModule](#aspectmodule) lists its options.

A complete HTTP application with transaction, retry and call trace aspects around the calls between its providers is in [examples/basic](https://github.com/thilllon/nestjs-kit/tree/main/packages/nestjs-aspect/examples/basic). Its README has the commands that run it.

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

`Retryable` takes a `RetryOptions` value and applies only to methods that return a promise; `@Retryable()` without a value or on a synchronous method is a compile error. `Internal` takes no value. [The example application](#the-example-application) applies both.

- The name is the identity of an annotation: annotations created with the same name read and write the same metadata.
- A method annotation belongs to the method that declares it; an override without the annotation does not carry it. A class annotation is inherited by subclasses. An annotation without a method contract also applies to accessors.
- **`requiresAdvice`** states that an annotated member must be advised by an advisor that handles the annotation: one whose pointcut refers to it with `P.annotated`, `P.withinAnnotated` or `P.targetAnnotated`, in any composition, or whose pointcut comes from `P.matching` or is hand-written. When no such advisor exists, for example because the aspect is not registered, `init()` fails, and in every mode a call of the member raises `AspectConfigurationError` instead of running without the advice. The same holds after the application has closed or has failed to initialize: on an instance its container created, the call of a member that requires advice raises `AspectConfigurationError`.
- `isAnnotation(value)` tells an annotation from other functions.
- Decorators created with Nest's `Reflector.createDecorator()` are accepted by `P.annotated`, `P.withinAnnotated`, `P.targetAnnotated` and `joinPoint.findAnnotation`.

## The example application

The sections on pointcuts, advice, ordering and inspection use this module. `PaymentGateway` stands in for the client of a remote payment service: `failures` holds the errors its next calls of `charge` throw, which lets an example fail a call.

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

  @Retryable({ attempts: 2 })
  async refund(receipt: string): Promise<string> {
    return `refund-${receipt}`;
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

## Pointcuts

The designators of `Pointcut`, imported as `P`, build typed pointcuts. `Pointcut<Shape>` is also the type of a pointcut, so the same import names both. A pointcut is a value: export it as a constant and share it between aspects.

| Selects by | Designator                                   | Matches                                                                                                         |
| ---------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Class      | `P.within(...Types)`                         | Members declared on one of the classes.                                                                         |
| Class      | `P.target(Type)`                             | Members of `Type` and its subclasses.                                                                           |
| Class      | `P.bean("token*" \| /Service$/ \| Type)`     | Classes registered under a matching provider token.                                                             |
| Class      | `P.inModule(Module, { transitive })`         | Providers and controllers a Nest module declares; with `transitive`, also those of the modules it imports.      |
| Class      | `P.withinAnnotated(A)`                       | Members declared on a class that carries `A`.                                                                   |
| Class      | `P.targetAnnotated(A)`                       | Members of a class that carries `A`.                                                                            |
| Member     | `P.method(Type, "name")`                     | That method of `Type` and its subclasses. Carries its exact signature. The only designator for lifecycle hooks. |
| Member     | `P.name("find*" \| /^find/)`                 | Members by name; `*` in a string matches any run of characters.                                                 |
| Member     | `P.kind("method" \| "getter" \| "setter")`   | Members by kind. The only designator for accessors.                                                             |
| Member     | `P.annotated(A)`                             | Members that carry `A`. Carries the method contract of `A` and guarantees `A`.                                  |
| Member     | `P.metadata(key, predicate?)`                | Members with Reflect metadata `key`, such as metadata stored by `SetMetadata`.                                  |
| Call       | `P.args(Account, P.ANY, P.REST)`             | Calls by their arguments, checked on every call. Types `joinPoint.args`.                                        |
| Custom     | `P.matching({ classFilter, methodMatcher })` | Members a hand-written class filter and method matcher accept.                                                  |

Compose pointcuts with `.and()`, `.or()` and `.not()`, or fold a list with `P.all(...)` and `P.any(...)`.

```ts
import { Pointcut as P } from "nestjs-aspect";

export const retryable = P.annotated(Retryable);
export const charge = P.method(PaymentGateway, "charge");
export const inBilling = P.inModule(BillingModule);
export const queries = inBilling
  .and(P.name("find*"))
  .and(P.annotated(Internal).not());
```

`queries` selects `AccountService.find`: `findAll` carries `Internal`, and `open` and `deposit` do not match the name.

- **Annotation or structure.** Select by annotation when a method opts in and carries a value for the advice, as `@Retryable({ attempts: 3 })` does. Select by module, provider token or name when the rule holds for a group of classes and must also hold for the classes added to it later.
- **`P.within` and `P.target`.** `P.within(AccountService)` selects the members `AccountService` itself declares. `P.target(AccountService)` selects every member of `AccountService` and of its subclasses, the members a subclass adds or overrides included.
- **Types.** `charge` carries the signature of `PaymentGateway.charge`, and `retryable` the method contract and the value type of `Retryable`. `P.args(Account, Number)` types `joinPoint.args` as `[Account, number]`. `and` guarantees the annotations of both sides, `or` those common to both, `not` none. Broad pointcuts such as `P.within` and `P.name` type arguments and results as `unknown`.
- **Default join points.** Broad pointcuts match methods only, and leave out the Nest lifecycle hooks `onModuleInit`, `onApplicationBootstrap`, `onModuleDestroy`, `beforeApplicationShutdown` and `onApplicationShutdown`. `P.method` selects a lifecycle hook, and `P.kind("getter")` or `P.kind("setter")` selects accessors. A constructor is never a join point.
- **Static and dynamic matching.** Every designator except `P.args` is evaluated once per class member when the class is woven. `P.args` is evaluated on every call of a member the rest of the pointcut matches; combine it with a static designator. In `P.args`, a class matches an argument that is `instanceof` it, `String`, `Number`, `Boolean`, `BigInt` and `Symbol` match their primitives, `P.ANY` matches one argument and `P.REST` the remaining ones.
- **`P.bean`** matches a class when one of its registrations has a matching token, `useClass` tokens included. A string or a regular expression is matched against the name of a class token, the text of a string token and the description of a symbol token. A `useExisting` token and the instance of a singleton `useFactory` or `useValue` provider are matched when the application initializes, and the instance of a request-scoped or transient `useFactory` provider when the container first resolves one. `P.bean` selects the class: its advice then applies to every instance of that class.
- **`P.inModule(Module, { transitive: true })`** follows the imports of the module. A global module counts only when the `@Module()` decorator of the importing module lists it.
- **`P.matching`** selects by a property no designator covers. `classFilter.matches(classRef)` receives the class (`type`) and its registrations (`beans`). `methodMatcher.matches(method)` receives a `MethodRef`: `name`, `kind`, `declaringType`, `targetType`, `original` (the function itself) and `isAsync`. `isRuntime: false` states that this decision, made once when the class is woven, is final; with `isRuntime: true`, `matchesRuntime(method, args)` also runs on every call. The [timing recipe](#timing-every-repository-of-a-module) uses it.

### Composition

A composed pointcut states a selection that would otherwise need a decorator on every method. These build on the pointcuts above:

```ts
import { Pointcut as P } from "nestjs-aspect";

// Reads by naming convention, in any class.
export const reads = P.any(P.name("find*"), P.name("get*"), P.name("list*"));

// Every other method of a module, for a concern of its writes such as a
// read-only switch: PaymentGateway.charge, PaymentGateway.refund,
// AccountService.open and AccountService.deposit.
export const billingWrites = inBilling.and(reads.not());

// Methods of one class by name, for a concern of the changes to an account:
// AccountService.open and AccountService.deposit.
export const accountChanges = P.within(AccountService).and(
  P.name(/^(open|deposit)$/),
);

// The classes of a module by provider token, for a concern of every
// outbound client: PaymentGateway.charge and PaymentGateway.refund.
export const gateways = P.all(inBilling, P.bean("*Gateway"));

// The calls of annotated methods by argument, for advice that reads the
// account: those of PaymentGateway.charge, not those of
// PaymentGateway.refund.
export const accountCharges = P.annotated(Retryable).and(
  P.args(Account, P.REST),
);
```

- `P.any()` and `.or()` widen a selection, `P.all()` and `.and()` narrow it, and `.not()` excludes from it. `reads.not()` alone matches almost every method of the application; `.not()` belongs behind `.and()`.
- `gateways` keeps selecting the gateways that later join the module. A class joins the selection by its registration, not by a decorator.
- `accountCharges` guarantees `Retryable` and types the first argument: its advice reads `joinPoint.annotation(Retryable).attempts` and `joinPoint.args[0].id`.
- A broad selection is worth checking. [Before](#before) lists the members an aspect advises with `AspectInspector`, the `report: "log"` option prints the same list as the [weaving report](#inspection), and a pointcut that matches no member is a warning of the [bootstrap validation](#bootstrap-validation).

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

Before advice runs ahead of the join point and can prevent it only by throwing. This aspect is a read-only switch for the writes of the billing module, whichever handler, job or service calls them; it uses `billingWrites` of [Composition](#composition).

```ts
import { Injectable } from "@nestjs/common";
import { Aspect, Before, type JoinPointOf } from "nestjs-aspect";

@Injectable()
export class Maintenance {
  readOnly = false;
}

@Aspect()
export class MaintenanceAspect {
  constructor(private readonly maintenance: Maintenance) {}

  @Before(billingWrites)
  check(joinPoint: JoinPointOf<typeof billingWrites>): void {
    if (this.maintenance.readOnly) {
      const { targetType, name } = joinPoint.signature;
      throw new Error(
        `${targetType.name}.${String(name)} is unavailable: the application is read-only`,
      );
    }
  }
}
```

No method of the module names the aspect, so the selection is worth checking. `AspectInspector` lists the members an aspect advises:

```ts
const inspector = app.get(AspectInspector);
const selected = inspector
  .advisedMembers()
  .filter(({ advisors }) =>
    advisors.some(({ type }) => type === MaintenanceAspect),
  )
  .map(({ type, name }) => `${type.name}.${String(name)}`);
// [
//   "PaymentGateway.charge",
//   "PaymentGateway.refund",
//   "AccountService.open",
//   "AccountService.deposit",
// ]
```

### After returning

After-returning advice receives the result of a normal completion: for a method that returns a promise, the value the promise resolves to. Its second parameter and `joinPoint.args` are typed from the pointcut, here `charge` of [Pointcuts](#pointcuts). An error the advice throws propagates instead of the result.

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

After-throwing advice receives the error of the join point: a thrown error or the rejection of its promise. With `throwing`, it runs only for errors that are `instanceof` that class. The same error propagates after the advice; an error the advice throws replaces it. It is not a catch block: the caller still receives the error. `Ledger` is the provider of [After returning](#after-returning).

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

Around advice surrounds the join point. `joinPoint.proceed()` runs the rest of the chain and the join point, and can be called zero times, once or several times; `joinPoint.proceedWith(...args)` runs it with other arguments. The value the advice returns is the result of the call. `retryable` of [Pointcuts](#pointcuts) guarantees the `Retryable` annotation, so `joinPoint.annotation(Retryable)` is typed as `RetryOptions`. The aspect retries the calls of an outbound client, here `PaymentGateway.charge` and `PaymentGateway.refund`, and does not repeat a call the remote system declined.

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

## Recipes

Each recipe advises calls that no Nest enhancer surrounds, and each one is a complete module. Retrying the calls of an outbound client is the fourth case of this kind: `RetryAspect` in [Around](#around).

### A transaction around a service method

An interceptor can open a transaction only around a whole route handler, and not at all for a method that a job or another service calls. The aspect delimits the transaction at the service method, and an `AsyncLocalStorage` carries it to the repositories the method calls.

```ts
import {
  Around,
  Aspect,
  createAnnotation,
  Pointcut as P,
  type ProceedingJoinPointOf,
} from "nestjs-aspect";

export const Transactional = createAnnotation<
  "Transactional",
  void,
  (...args: any[]) => Promise<unknown>
>("Transactional", { requiresAdvice: true });

export const transactional = P.annotated(Transactional);

@Aspect({ order: 100 })
export class TransactionAspect {
  constructor(private readonly database: Database) {}

  @Around(transactional)
  run(
    joinPoint: ProceedingJoinPointOf<typeof transactional>,
  ): Promise<unknown> {
    return this.database.transactional(() => joinPoint.proceed());
  }
}
```

- Calling `this.database.transactional(...)` inside one method is equivalent. The annotation states the boundary once for every method that carries it, and the aspect, unlike a plain `@Transactional` method decorator, injects `Database` instead of reaching it through global state.
- A lower `order` is the outer advice. With `order: 100`, a retry aspect of order 20 on the same method retries the whole transaction, and each attempt begins a new one.
- `P.annotated(Transactional)` selects annotated methods. The [advisor form](#advisors) of this aspect also covers `@Transactional()` on a class.
- `requiresAdvice` keeps a `@Transactional()` method from running without a transaction: when `TransactionAspect` is not registered, the application fails to initialize, and a call of the method raises `AspectConfigurationError` in every mode.

`Database` stands in for a database client. A real application calls the transaction callback of its client in `transactional` and keeps the `AsyncLocalStorage` lookup where its repositories obtain the connection. A call inside an active transaction joins it.

```ts
import { AsyncLocalStorage } from "node:async_hooks";
import { Injectable } from "@nestjs/common";

@Injectable()
export class Database {
  private readonly committed = new Map<string, number>();

  private readonly transaction = new AsyncLocalStorage<Map<string, number>>();

  readonly log: string[] = [];

  read(key: string): number {
    const writes = this.transaction.getStore();
    return writes?.get(key) ?? this.committed.get(key) ?? 0;
  }

  write(key: string, value: number): void {
    (this.transaction.getStore() ?? this.committed).set(key, value);
  }

  async transactional<T>(work: () => Promise<T>): Promise<T> {
    if (this.transaction.getStore()) {
      return work();
    }
    const writes = new Map<string, number>();
    this.log.push("begin");
    try {
      const result = await this.transaction.run(writes, work);
      for (const [key, value] of writes) {
        this.committed.set(key, value);
      }
      this.log.push("commit");
      return result;
    } catch (error) {
      this.log.push("rollback");
      throw error;
    }
  }
}
```

The repository and the service know neither the aspect nor the transaction:

```ts
import { Injectable, Module } from "@nestjs/common";
import { AspectModule } from "nestjs-aspect";

@Injectable()
export class WalletRepository {
  constructor(private readonly database: Database) {}

  async balance(owner: string): Promise<number> {
    return this.database.read(owner);
  }

  async add(owner: string, amount: number): Promise<void> {
    const balance = this.database.read(owner) + amount;
    if (balance < 0) {
      throw new RangeError(`${owner} cannot pay ${-amount}`);
    }
    this.database.write(owner, balance);
  }
}

@Injectable()
export class WalletService {
  constructor(private readonly wallets: WalletRepository) {}

  @Transactional()
  async move(from: string, to: string, amount: number): Promise<void> {
    await this.wallets.add(to, amount);
    await this.wallets.add(from, -amount);
  }

  async payEach(
    from: string,
    recipients: string[],
    amount: number,
  ): Promise<void> {
    for (const to of recipients) {
      await this.move(from, to, amount);
    }
  }
}

@Module({
  imports: [AspectModule.forRoot()],
  providers: [Database, TransactionAspect, WalletRepository, WalletService],
})
export class WalletModule {}
```

`payEach` carries no annotation and calls `move` on the same object. Each of those calls is advised and runs in its own transaction, so the payment that fails rolls back alone:

```ts
const app = await NestFactory.createApplicationContext(WalletModule);
const wallets = app.get(WalletRepository);
const service = app.get(WalletService);

await wallets.add("alice", 25);

await service.move("alice", "bob", 10);
await service.payEach("alice", ["bob", "carol"], 10).catch(() => undefined);

const balances = [
  await wallets.balance("alice"),
  await wallets.balance("bob"),
  await wallets.balance("carol"),
];
const { log } = app.get(Database);
// balances: [5, 20, 0]
// log: ["begin", "commit", "begin", "commit", "begin", "rollback"]
```

### Jobs outside the request pipeline

A method that a timer, a scheduler, an event emitter or a queue worker calls is no handler: no interceptor surrounds it and no exception filter receives its error. What happens to a failure is left to whatever calls the method. The aspect gives every job the failure reporting that an exception filter gives the handlers, whatever starts the job.

```ts
import { Injectable, Module } from "@nestjs/common";
import {
  AfterThrowing,
  Aspect,
  AspectModule,
  createAnnotation,
  type JoinPointOf,
  Pointcut as P,
} from "nestjs-aspect";

export const Job = createAnnotation<
  "Job",
  string,
  (...args: any[]) => Promise<unknown>
>("Job", { requiresAdvice: true });

export const jobs = P.annotated(Job);

@Injectable()
export class ErrorReporter {
  readonly reports: string[] = [];

  report(source: string, error: unknown): void {
    this.reports.push(`${source}: ${error}`);
  }
}

@Aspect()
export class JobAspect {
  constructor(private readonly reporter: ErrorReporter) {}

  @AfterThrowing(jobs)
  failed(joinPoint: JoinPointOf<typeof jobs>, error: unknown): void {
    this.reporter.report(joinPoint.annotation(Job), error);
  }
}

@Injectable()
export class Outbox {
  readonly pending: string[] = [];

  readonly sent: string[] = [];

  async flush(): Promise<void> {
    while (this.pending.length > 0) {
      if (this.pending[0] === "") {
        throw new Error("Cannot send an empty message");
      }
      this.sent.push(...this.pending.splice(0, 1));
    }
  }
}

@Injectable()
export class OutboxRelayJob {
  constructor(private readonly outbox: Outbox) {}

  @Job("outbox-relay")
  async relay(): Promise<void> {
    await this.outbox.flush();
  }
}

@Module({
  imports: [AspectModule.forRoot()],
  providers: [ErrorReporter, JobAspect, Outbox, OutboxRelayJob],
})
export class JobsModule {}
```

`ErrorReporter` stands in for the client of an error tracker. `@Job` goes on the provider method that the scheduler, listener or consumer decorator of the application marks. After-throwing advice reports the error and does not swallow it: the caller still receives the rejection, so a queue worker still retries the job or moves it to its dead-letter queue. `flush` removes a message only after it is sent, so the retry finds the message that failed.

```ts
const app = await NestFactory.createApplicationContext(JobsModule);
const job = app.get(OutboxRelayJob);
const outbox = app.get(Outbox);

outbox.pending.push("welcome");
await job.relay();
outbox.pending.push("");
const [outcome] = await Promise.allSettled([job.relay()]);

const { reports } = app.get(ErrorReporter);
// outcome.status: "rejected"
// reports: ["outbox-relay: Error: Cannot send an empty message"]
```

A message handler of a Nest microservice (`@MessagePattern`, `@EventPattern`) is a handler: it has the enhancer chain, and an exception filter is the tool there.

### Timing every repository of a module

An interceptor times a handler. Timing the repositories behind it with enhancers is not possible, and a decorator on every repository method leaves out the method added next. The pointcut selects the asynchronous methods of every provider of `PersistenceModule` whose token ends in `Repository`; the repositories carry no decorator. The recipe times the repositories an application writes; the queries of a database driver are timed by the instrumentation of that driver.

```ts
import { Injectable, Module } from "@nestjs/common";
import {
  Around,
  Aspect,
  AspectModule,
  Pointcut as P,
  type ProceedingJoinPointOf,
} from "nestjs-aspect";

@Injectable()
export class UserRepository {
  private readonly names = new Map<number, string>();

  async findName(id: number): Promise<string | undefined> {
    return this.names.get(id);
  }

  async rename(id: number, name: string): Promise<void> {
    this.names.set(id, name);
  }

  size(): number {
    return this.names.size;
  }
}

@Injectable()
export class OrderRepository {
  async findByUser(userId: number): Promise<string[]> {
    return userId === 1 ? ["order-1"] : [];
  }
}

@Injectable()
export class IdGenerator {
  private last = 0;

  async next(): Promise<number> {
    this.last += 1;
    return this.last;
  }
}

@Module({
  providers: [UserRepository, OrderRepository, IdGenerator],
  exports: [UserRepository, OrderRepository, IdGenerator],
})
export class PersistenceModule {}

export const repositoryQueries = P.all(
  P.inModule(PersistenceModule),
  P.bean("*Repository"),
  P.matching({
    methodMatcher: { isRuntime: false, matches: (method) => method.isAsync },
  }),
);

@Injectable()
export class Timings {
  readonly samples: { member: string; milliseconds: number }[] = [];
}

@Aspect()
export class RepositoryTimingAspect {
  constructor(private readonly timings: Timings) {}

  @Around(repositoryQueries)
  async time(
    joinPoint: ProceedingJoinPointOf<typeof repositoryQueries>,
  ): Promise<unknown> {
    const { targetType, name } = joinPoint.signature;
    const started = performance.now();
    try {
      return await joinPoint.proceed();
    } finally {
      this.timings.samples.push({
        member: `${targetType.name}.${String(name)}`,
        milliseconds: performance.now() - started,
      });
    }
  }
}

@Module({
  imports: [AspectModule.forRoot(), PersistenceModule],
  providers: [Timings, RepositoryTimingAspect],
})
export class ReportingModule {}
```

`UserRepository.size` is synchronous and `IdGenerator` is no repository, so neither is timed:

```ts
const app = await NestFactory.createApplicationContext(ReportingModule);
const users = app.get(UserRepository);

await users.rename(1, "Ada");
await users.findName(1);
users.size();
await app.get(OrderRepository).findByUser(1);
await app.get(IdGenerator).next();

const { samples } = app.get(Timings);
const timed = samples.map(({ member }) => member);
// ["UserRepository.rename", "UserRepository.findName", "OrderRepository.findByUser"]
```

`MethodRef.isAsync` keeps the asynchronous advice away from synchronous methods. It is true for a method declared `async`, and for a decorated method whose declared return type is `Promise`: a repository method that returns a promise without either is not selected.

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
  Pointcut as P,
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

### Other result types

A `ReturnValueAdapter` makes advice follow a result that settles after the method has returned and is neither a promise nor an Observable. An `async` generator method returns its generator before it has produced a value: without an adapter, after advice runs at that moment and after-throwing advice never sees an error that a later iteration raises. This adapter follows the generator to its end:

```ts
import { Injectable } from "@nestjs/common";
import {
  After,
  AfterReturning,
  AfterThrowing,
  Aspect,
  type JoinPointOf,
  Pointcut as P,
  type ReturnValueAdapter,
} from "nestjs-aspect";

export const asyncGeneratorAdapter: ReturnValueAdapter<
  AsyncGenerator<unknown>
> = {
  supports(value: unknown): value is AsyncGenerator<unknown> {
    return Object.prototype.toString.call(value) === "[object AsyncGenerator]";
  },
  async *onSuccess(value, callback) {
    let last: unknown;
    for await (const item of value) {
      last = item;
      yield item;
    }
    await callback(last);
  },
  async *onError(value, callback) {
    try {
      yield* value;
    } catch (error) {
      await callback(error);
      throw error;
    }
  },
  async *finally(value, callback) {
    try {
      yield* value;
    } finally {
      await callback();
    }
  },
};

@Injectable()
export class EventStore {
  readonly events = new Map<string, string[]>();

  async *replay(stream: string): AsyncGenerator<string> {
    const events = this.events.get(stream);
    if (!events) {
      throw new Error(`Unknown stream ${stream}`);
    }
    yield* events;
  }
}

export const replays = P.method(EventStore, "replay");

@Aspect()
export class ReplayAspect {
  readonly lines: string[] = [];

  @After(replays)
  closed(joinPoint: JoinPointOf<typeof replays>): void {
    this.lines.push(`${joinPoint.args[0]} closed`);
  }

  @AfterReturning(replays)
  finished(joinPoint: JoinPointOf<typeof replays>, last: unknown): void {
    this.lines.push(`${joinPoint.args[0]} ended with ${last}`);
  }

  @AfterThrowing(replays)
  failed(joinPoint: JoinPointOf<typeof replays>, error: unknown): void {
    this.lines.push(`${joinPoint.args[0]} failed: ${error}`);
  }
}
```

Register it with `AspectModule.forRoot({ returnValueAdapters: [asyncGeneratorAdapter] })`. `closed` runs when the consumer has read the last event, when it leaves the loop early and when the replay fails. `finished` runs only when the consumer has read the last event, and receives that event. `failed` runs for an error that an iteration raises, here the unknown stream at the first one. Like an Observable, a generator that is never iterated runs no after advice.

- `supports` decides by value which results the adapter follows; adapters are consulted in the order of the option, before the built-in `promiseAdapter`.
- `onSuccess` calls `callback` with the value after-returning advice receives, `onError` with the error, and `finally` without an argument. Each returns a result of the same type and waits for what `callback` returns.

## Scopes, self-invocation and the request pipeline

- **Targets of every scope are advised**: singleton, request-scoped and transient.
- **Aspects and advisors are singletons.** One that is request-scoped or transient, by its own scope or because it depends on a request-scoped provider, is rejected when the application initializes. Per-request state belongs to the join point. Advice has no request object, so the route that works for every call is an `AsyncLocalStorage`: a middleware or a guard stores the user or the tenant of the request, and the advice reads the store, also in the calls a job makes inside its own store. `ModuleRef.resolve()` needs a context id, which `ContextIdFactory.getByRequest()` derives from the request: advice can use it only where the target exposes the request, as a request-scoped provider that injects `REQUEST` does.
- **Aspects and advisors are never advised.** An aspect inherits the advice of a superclass without `@Aspect`; an aspect that extends another `@Aspect` class is rejected.
- **Self-invocation is advised.** A call from a method to another method of the same object (`this.other()`) runs the advice of that method, unlike in Spring: the dispatcher is the member on the class prototype, not a proxy in front of the object. The [transaction recipe](#a-transaction-around-a-service-method) relies on it.
- **Controllers.** On a route handler, advice runs inside the Nest interceptors and after the pipes, so it sees the transformed arguments:

  ```
  middleware -> guards -> interceptors -> pipes -> [ advice -> route handler ] -> interceptors -> exception filters
  ```

  An error thrown by advice reaches the exception filters like an error of the handler. Route metadata and `SetMetadata` values stay visible on a woven handler.

## Advisors

`@Advisor()` marks a provider as an advisor: one pointcut and one advice, the layer aspects compile to. The static member `pointcut` selects the join points; an instance supplies `advice`, a `MethodInterceptor`, and an optional `order`. This advisor is the counterpart of `TransactionAspect` of the [transaction recipe](#a-transaction-around-a-service-method), with its `Transactional` annotation and its `Database`, and also covers the methods of a class that carries `@Transactional()`. `Account` is the class of [the example application](#the-example-application).

```ts
import { Injectable } from "@nestjs/common";
import { Advisor, type MethodInterceptor, Pointcut as P } from "nestjs-aspect";

@Advisor()
export class TransactionAdvisor {
  static readonly pointcut = P.annotated(Transactional).or(
    P.withinAnnotated(Transactional),
  );

  readonly order = 100;

  readonly advice: MethodInterceptor = {
    invoke: (invocation) =>
      this.database.transactional(async () => invocation.proceed()),
  };

  constructor(private readonly database: Database) {}
}

@Injectable()
@Transactional()
export class InvoiceService {
  constructor(private readonly database: Database) {}

  async issue(account: Account, amount: number): Promise<string> {
    this.database.write(`invoiced:${account.id}`, amount);
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

`Ledger` is the provider of [After returning](#after-returning).

```ts
import { Injectable, Scope } from "@nestjs/common";
import { Aspect, Before, Pointcut as P } from "nestjs-aspect";

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

`@DeclareParents` declares that the classes a pointcut or class filter selects implement another interface, and names the class that implements it. The example uses `Session` and `sessions` of [Instantiation models](#instantiation-models). The decorator applies to a static member of an aspect whose type is the interface: an abstract class, because a TypeScript interface leaves no value at run time.

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
- **Replaced aspects.** An aspect replaced with `overrideProvider(...).useValue(...)` is no aspect any more: its advice does not run, and a member whose annotation requires that advice is treated like one whose aspect is not registered.
- **A service with `requiresAdvice` annotations.** A unit test creates the service with `new` and its collaborators: outside a live application the methods run without advice. A test of the service inside a testing module registers the aspect with it.
- **An aspect.** Compile a testing module with `AspectModule.forRoot()`, the aspect and a small target class, call the target and assert on the effect, as the modules of the [recipes](#recipes) do.

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
| `@Pointcut` method                                                  | An exported constant built with `Pointcut`                               |
| AspectJ pointcut expression, `&&`, `\|\|`, `!`                      | `Pointcut` designators, `.and()`, `.or()`, `.not()`                      |
| `execution(* Type+.name(..))`, a name pattern of `execution`        | `P.method(Type, "name")`, `P.name()`                                     |
| `within(Type)`, `target(Type)`, `this(Type)`                        | `P.within(Type)`, `P.target(Type)`                                       |
| `@annotation(A)`, `@within(A)`, `@target(A)`                        | `P.annotated(A)`, `P.withinAnnotated(A)`, `P.targetAnnotated(A)`         |
| `args(Account, *, ..)`                                              | `P.args(Account, P.ANY, P.REST)`                                         |
| Attribute-driven pointcut                                           | `P.metadata()`                                                           |
| Custom `Pointcut`                                                   | `P.matching()`                                                           |
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
