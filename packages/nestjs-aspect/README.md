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

An annotation marks the methods, an aspect holds the behavior, and `AspectModule.forRoot()` weaves the aspect into the application. `Pointcut` is the namespace of the pointcut designators, the functions that build pointcuts; the examples import it as `P` for brevity. This application records who changed what: every audited method leaves an entry with its actor, whether it succeeds or fails.

```ts
import { AsyncLocalStorage } from "node:async_hooks";
import { Injectable, Module, NotFoundException } from "@nestjs/common";
import {
  AfterReturning,
  AfterThrowing,
  Aspect,
  AspectModule,
  createAnnotation,
  type JoinPointOf,
  Pointcut as P,
} from "nestjs-aspect";

export const Audited = createAnnotation<
  "Audited",
  string,
  (subject: string, ...rest: any[]) => Promise<unknown>
>("Audited");

const audited = P.annotated(Audited);

@Injectable()
export class Actor {
  private readonly storage = new AsyncLocalStorage<string>();

  run<T>(actor: string, work: () => T): T {
    return this.storage.run(actor, work);
  }

  current(): string | undefined {
    return this.storage.getStore();
  }
}

export interface AuditEntry {
  action: string;
  actor: string;
  subject: string;
  outcome: "ok" | "failed";
  error?: string;
}

@Injectable()
export class AuditLog {
  readonly entries: AuditEntry[] = [];

  async record(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
  }
}

@Aspect()
export class AuditAspect {
  constructor(
    private readonly actor: Actor,
    private readonly log: AuditLog,
  ) {}

  @AfterReturning(audited)
  async succeeded(joinPoint: JoinPointOf<typeof audited>): Promise<void> {
    await this.log.record(this.entry(joinPoint, "ok"));
  }

  @AfterThrowing(audited)
  async failed(
    joinPoint: JoinPointOf<typeof audited>,
    error: unknown,
  ): Promise<void> {
    await this.log.record({
      ...this.entry(joinPoint, "failed"),
      error: error instanceof Error ? error.name : typeof error,
    });
  }

  private entry(
    joinPoint: JoinPointOf<typeof audited>,
    outcome: AuditEntry["outcome"],
  ): AuditEntry {
    return {
      action: joinPoint.annotation(Audited),
      actor: this.actor.current() ?? "anonymous",
      subject: joinPoint.args[0],
      outcome,
    };
  }
}

@Injectable()
export class MemberService {
  private readonly roles = new Map<string, string>();

  @Audited("member.invite")
  async invite(memberId: string, role: string): Promise<void> {
    this.roles.set(memberId, role);
  }

  @Audited("member.remove")
  async remove(memberId: string): Promise<void> {
    if (!this.roles.delete(memberId)) {
      throw new NotFoundException(`Unknown member ${memberId}`);
    }
  }
}

@Injectable()
export class ApiKeyService {
  private readonly revoked = new Set<string>();

  @Audited("api-key.revoke")
  async revoke(keyId: string): Promise<void> {
    this.revoked.add(keyId);
  }
}

@Module({
  imports: [AspectModule.forRoot()],
  providers: [Actor, AuditLog, AuditAspect, MemberService, ApiKeyService],
})
export class AppModule {}
```

- **`Actor`** carries the identity of the caller in an `AsyncLocalStorage`. A middleware or a guard calls `actor.run()` for a request and a job for its run, so the advice finds the actor wherever the call starts.
- **`Audited`** takes the name of the action. Its method contract states that an audited method returns a promise and names what it changes in its first argument: the annotation on any other method is a compile error, and the advice reads `joinPoint.args[0]` as a `string`. An entry holds the fields the advice names and no other argument of the call.
- **`AuditLog`** stands in for the audit table, and the collections of the services for their tables.

The services carry the annotation and no audit code. The advice runs when the promise of a call settles:

```ts
import { NestFactory } from "@nestjs/core";

const app = await NestFactory.createApplicationContext(AppModule);
const members = app.get(MemberService);

await app.get(Actor).run("alice", async () => {
  await members.invite("member-7", "editor");
  await app.get(ApiKeyService).revoke("key-3");
});
await members.remove("member-9").catch(() => undefined);

const { entries } = app.get(AuditLog);
// [
//   { action: "member.invite", actor: "alice", subject: "member-7", outcome: "ok" },
//   { action: "api-key.revoke", actor: "alice", subject: "key-3", outcome: "ok" },
//   {
//     action: "member.remove",
//     actor: "anonymous",
//     subject: "member-9",
//     outcome: "failed",
//     error: "NotFoundException",
//   },
// ]
```

Without the aspect, each of the three methods wraps its body in a `try`/`catch` that calls `this.log.record(...)` on both paths. Import `AspectModule.forRoot()` once, as the first import of the root module; [AspectModule](#aspectmodule) lists its options.

A complete HTTP application with transaction, retry and call statistics aspects around the calls between its providers, and a worker that makes those calls without a request, is in [examples/basic](https://github.com/thilllon/nestjs-kit/tree/main/packages/nestjs-aspect/examples/basic). Its README has the commands that run it.

## Annotations

`createAnnotation(name, options?)` creates a typed metadata decorator for methods and classes. Its type parameters are the name literal, the value type and the method contract the annotation accepts.

```ts
import { createAnnotation } from "nestjs-aspect";

export interface RetryOptions {
  attempts: number;
  backoffMilliseconds: number;
}

export class TransientError extends Error {}

export const Retryable = createAnnotation<
  "Retryable",
  RetryOptions,
  (...args: any[]) => Promise<unknown>
>("Retryable", { requiresAdvice: true });

export const RequiresPermission = createAnnotation<
  "RequiresPermission",
  string
>("RequiresPermission", { requiresAdvice: true });

export const Evicts = createAnnotation<
  "Evicts",
  (...args: any[]) => string,
  (...args: any[]) => Promise<unknown>
>("Evicts");
```

- **`Retryable`** takes a `RetryOptions` value and applies only to methods that return a promise; `@Retryable()` without a value or on a synchronous method is a compile error. It marks a call that is safe to repeat: a read, a write that carries an idempotency key, or a transaction that has rolled back. `TransientError` is the class of the errors after which another attempt can succeed.
- **`RequiresPermission`** takes the name of a permission.
- **`Evicts`** takes a function from the arguments of the method to a cache key.
- An annotation created without a value type, as `createAnnotation<"Draft">("Draft")`, is applied without an argument: `@Draft()`.

[The example application](#the-example-application) applies the three, and [Advice](#advice) has the aspect of each.

- The name is the identity of an annotation: annotations created with the same name read and write the same metadata.
- A method annotation belongs to the method that declares it; an override without the annotation does not carry it. A class annotation is inherited by subclasses. An annotation without a method contract also applies to accessors.
- **`requiresAdvice`** states that an annotated member must be advised by an advisor that handles the annotation: one whose pointcut refers to it with `P.annotated`, `P.withinAnnotated` or `P.targetAnnotated`, in any composition, or whose pointcut comes from `P.matching` or is hand-written. When no such advisor exists, for example because the aspect is not registered, `init()` fails, and in every mode a call of the member raises `AspectConfigurationError` instead of running without the advice. The same holds after the application has closed or has failed to initialize: on an instance its container created, the call of a member that requires advice raises `AspectConfigurationError`.
- `isAnnotation(value)` tells an annotation from other functions.
- Decorators created with Nest's `Reflector.createDecorator()` are accepted by `P.annotated`, `P.withinAnnotated`, `P.targetAnnotated` and `joinPoint.findAnnotation`.

## The example application

The sections on pointcuts, advice, ordering and inspection use one module: two clients of remote services, a repository and two services. The module reaches its infrastructure through abstract classes, which are also the injection tokens:

```ts
export class TransportError extends Error {}

export abstract class Transport {
  abstract send<T>(operation: string, payload: object): Promise<T>;
}

export abstract class Cache {
  abstract wrap<T>(key: string, load: () => Promise<T>): Promise<T>;

  abstract del(key: string): Promise<void>;
}
```

`Transport` sends a request to a remote service and rejects with `TransportError` when no answer arrives. `Cache` has the `wrap` and `del` of the cache that `@nestjs/cache-manager` provides. `InfrastructureModule` binds the abstract classes of this README to the adapters of the application; [the tests that run these examples](https://github.com/thilllon/nestjs-kit/blob/main/packages/nestjs-aspect/src/readme-examples.test.ts) bind in-memory ones.

```ts
import { Injectable, Module, NotFoundException } from "@nestjs/common";
import { defer, mergeAll, type Observable } from "rxjs";

@Injectable()
export class PaymentClient {
  constructor(private readonly transport: Transport) {}

  @Retryable({ attempts: 3, backoffMilliseconds: 200 })
  async charge(idempotencyKey: string, amount: number): Promise<string> {
    return this.transport.send("payments/charge", { idempotencyKey, amount });
  }

  @Retryable({ attempts: 3, backoffMilliseconds: 200 })
  async refund(idempotencyKey: string, chargeId: string): Promise<string> {
    return this.transport.send("payments/refund", { idempotencyKey, chargeId });
  }

  async *settlements(day: string): AsyncGenerator<string> {
    let cursor: string | undefined;
    do {
      const page = await this.transport.send<{
        items: string[];
        next?: string;
      }>("payments/settlements", { day, cursor });
      yield* page.items;
      cursor = page.next;
    } while (cursor);
  }
}

@Injectable()
export class ShippingClient {
  constructor(private readonly transport: Transport) {}

  @Retryable({ attempts: 2, backoffMilliseconds: 200 })
  async quote(destination: string): Promise<number> {
    return this.transport.send("shipping/quote", { destination });
  }

  async book(orderId: string, destination: string): Promise<string> {
    return this.transport.send("shipping/book", { orderId, destination });
  }

  track(shipmentId: string): Observable<string> {
    return defer(() =>
      this.transport.send<string[]>("shipping/track", { shipmentId }),
    ).pipe(mergeAll());
  }
}

@Injectable()
export class ProductRepository {
  private readonly prices = new Map<string, number>();

  async findPrice(sku: string): Promise<number | undefined> {
    return this.prices.get(sku);
  }

  async savePrice(sku: string, price: number): Promise<void> {
    this.prices.set(sku, price);
  }

  async remove(sku: string): Promise<void> {
    this.prices.delete(sku);
  }
}

const priceKey = (sku: string) => `price:${sku}`;

@Injectable()
export class CatalogService {
  constructor(
    private readonly products: ProductRepository,
    private readonly cache: Cache,
  ) {}

  async price(sku: string): Promise<number | undefined> {
    return this.cache.wrap(priceKey(sku), () => this.products.findPrice(sku));
  }

  @RequiresPermission("catalog:write")
  @Evicts(priceKey)
  async reprice(sku: string, price: number): Promise<void> {
    await this.products.savePrice(sku, price);
  }

  @RequiresPermission("catalog:write")
  @Evicts(priceKey)
  async discontinue(sku: string): Promise<void> {
    await this.products.remove(sku);
  }
}

@Injectable()
export class CheckoutService {
  constructor(
    private readonly catalog: CatalogService,
    private readonly payments: PaymentClient,
    private readonly shipping: ShippingClient,
  ) {}

  async pay(
    orderId: string,
    sku: string,
    destination: string,
  ): Promise<string> {
    const price = await this.catalog.price(sku);
    if (price === undefined) {
      throw new NotFoundException(`Unknown product ${sku}`);
    }
    const delivery = await this.shipping.quote(destination);
    return this.payments.charge(`charge:${orderId}`, price + delivery);
  }

  @RequiresPermission("payments:refund")
  async refund(orderId: string, chargeId: string): Promise<string> {
    return this.payments.refund(`refund:${orderId}`, chargeId);
  }

  @RequiresPermission("orders:ship")
  async ship(orderId: string, destination: string): Promise<string> {
    return this.shipping.book(orderId, destination);
  }
}

@Module({
  imports: [InfrastructureModule],
  providers: [
    PaymentClient,
    ShippingClient,
    ProductRepository,
    CatalogService,
    CheckoutService,
  ],
  exports: [
    PaymentClient,
    ShippingClient,
    ProductRepository,
    CatalogService,
    CheckoutService,
  ],
})
export class ShopModule {}
```

- `charge` and `refund` send an idempotency key and `quote` is a read, so the three are `@Retryable`. `book` has no key: a second attempt could book a second shipment, and the method carries no annotation.
- `settlements` requests the pages of a remote list while its caller iterates, and `track` returns a cold Observable, as a client built on `HttpService` does. [Asynchronous join points](#asynchronous-join-points) covers both.
- The collection of `ProductRepository` stands in for a table.

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
| Call       | `P.args(String, P.ANY, P.REST)`              | Calls by their arguments, checked on every call. Types `joinPoint.args`.                                        |
| Custom     | `P.matching({ classFilter, methodMatcher })` | Members a hand-written class filter and method matcher accept.                                                  |

Compose pointcuts with `.and()`, `.or()` and `.not()`, or fold a list with `P.all(...)` and `P.any(...)`. These are the pointcuts of the aspects in [Advice](#advice):

```ts
import { Pointcut as P } from "nestjs-aspect";

export const retryable = P.annotated(Retryable);
export const guarded = P.annotated(RequiresPermission);
export const evicting = P.annotated(Evicts);

export const asynchronous = P.matching({
  methodMatcher: { isRuntime: false, matches: (method) => method.isAsync },
});

export const clients = P.inModule(ShopModule).and(P.bean("*Client"));
export const clientCalls = clients.and(asynchronous);
```

- `retryable`, `guarded` and `evicting` select the methods that carry an annotation.
- `clients` selects every method of every provider of `ShopModule` whose token ends in `Client`: the six methods of `PaymentClient` and `ShippingClient`, which carry no decorator for it, and those of a client that joins the module later.
- `asynchronous` selects the methods known to return a promise. `MethodRef.isAsync` is true for a method declared `async`, and for a decorated method whose declared return type is `Promise`; a method that returns a promise without either is not selected.
- `clientCalls` is the part of `clients` that returns a promise. It leaves out `settlements` and `track`, whose results settle after the method has returned, if they are consumed at all.

Further rules:

- **Annotation or structure.** Select by annotation when a method opts in and carries a value for the advice, as `@Retryable({ attempts: 3, backoffMilliseconds: 200 })` does. Select by module or provider token when the rule holds for a group of classes and must also hold for the classes added to it later.
- **Names.** A selection by name, such as `P.name("find*")`, holds as long as the naming convention does: a method that departs from the convention leaves or joins the selection without an error. `.not()` alone matches almost every method of the application; it belongs behind `.and()`.
- **Checking a selection.** No method names the aspect that a structural pointcut applies to it. [Inspection](#inspection) pins the selected members in a test, the `report: "log"` option prints them as the weaving report, and a pointcut that matches no member is a warning of the [bootstrap validation](#bootstrap-validation).
- **`P.within` and `P.target`.** `P.within(CatalogService)` selects the members `CatalogService` itself declares. `P.target(CatalogService)` selects every member of `CatalogService` and of its subclasses, the members a subclass adds or overrides included.
- **Types.** `retryable` carries the method contract and the value type of `Retryable`. `P.method(ShippingClient, "quote")` carries the signature of that method: its advice reads `joinPoint.args` as `[string]` and the result of after-returning advice as `number`. `P.args(String, Number)` types `joinPoint.args` as `[string, number]`. `and` guarantees the annotations of both sides, `or` those common to both, `not` none. Broad pointcuts such as `P.within` and `P.name` type arguments and results as `unknown`.
- **Default join points.** Broad pointcuts match methods only, and leave out the Nest lifecycle hooks `onModuleInit`, `onApplicationBootstrap`, `onModuleDestroy`, `beforeApplicationShutdown` and `onApplicationShutdown`. `P.method` selects a lifecycle hook, and `P.kind("getter")` or `P.kind("setter")` selects accessors. A constructor is never a join point.
- **Static and dynamic matching.** Every designator except `P.args` is evaluated once per class member when the class is woven. `P.args` is evaluated on every call of a member the rest of the pointcut matches; combine it with a static designator. In `P.args`, a class matches an argument that is `instanceof` it, `String`, `Number`, `Boolean`, `BigInt` and `Symbol` match their primitives, `P.ANY` matches one argument and `P.REST` the remaining ones.
- **`P.bean`** matches a class when one of its registrations has a matching token, `useClass` tokens included. A string or a regular expression is matched against the name of a class token, the text of a string token and the description of a symbol token. A `useExisting` token and the instance of a singleton `useFactory` or `useValue` provider are matched when the application initializes, and the instance of a request-scoped or transient `useFactory` provider when the container first resolves one. `P.bean` selects the class: its advice then applies to every instance of that class.
- **`P.inModule(Module, { transitive: true })`** follows the imports of the module. A global module counts only when the `@Module()` decorator of the importing module lists it.
- **`P.matching`** selects by a property no designator covers. `classFilter.matches(classRef)` receives the class (`type`) and its registrations (`beans`). `methodMatcher.matches(method)` receives a `MethodRef`: `name`, `kind`, `declaringType`, `targetType`, `original` (the function itself) and `isAsync`. `isRuntime: false` states that this decision, made once when the class is woven, is final; with `isRuntime: true`, `matchesRuntime(method, args)` also runs on every call.

## Advice

`@Aspect({ order?, instantiation? })` marks a class as an aspect and as a Nest provider; list it in the `providers` of a module. Each advice decorator takes a pointcut and checks the signature of the method it decorates against it. `JoinPointOf<typeof pointcut>` and `ProceedingJoinPointOf<typeof pointcut>` are the join point types of a pointcut.

| Decorator                                 | Advice signature                                                                | Semantics                                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `@Before(pointcut)`                       | `(joinPoint: JoinPointOf<typeof pointcut>)`                                     | Runs before the join point. An error prevents the join point and propagates.                                        |
| `@AfterReturning(pointcut)`               | `(joinPoint: JoinPointOf<typeof pointcut>, result)`                             | Runs after a normal completion with the result. It cannot replace the result.                                       |
| `@AfterThrowing(pointcut, { throwing? })` | `(joinPoint: JoinPointOf<typeof pointcut>, error)`                              | Runs when the join point fails, with `throwing` only for errors of that class. The error propagates afterwards.     |
| `@After(pointcut)`                        | `(joinPoint: JoinPointOf<typeof pointcut>)`                                     | Runs after the join point, whatever its outcome.                                                                    |
| `@Around(pointcut)`                       | `(joinPoint: ProceedingJoinPointOf<typeof pointcut>)` returning the result type | Surrounds the join point: it decides whether and how often the join point runs, and its return value is the result. |

Use the least powerful advice that does the job: an after-returning advice cannot forget to call `proceed()`. The aspects below advise [the example application](#the-example-application) with the pointcuts of [Pointcuts](#pointcuts); [Ordering](#ordering) explains their `order` values.

### Before

Before advice runs ahead of the join point and can prevent it only by throwing. This aspect checks a permission at the service method. A guard checks it at a route handler; the same method called by a job, a queue consumer or another service passes no guard. `Actor` is the provider of the [Quick start](#quick-start), and `Permissions` stands in for the store of the granted permissions.

```ts
import { ForbiddenException, Injectable } from "@nestjs/common";
import { Aspect, Before, type JoinPointOf } from "nestjs-aspect";

@Injectable()
export class Permissions {
  private readonly granted = new Map<string, Set<string>>();

  grant(actor: string, permission: string): void {
    const permissions = this.granted.get(actor) ?? new Set<string>();
    this.granted.set(actor, permissions.add(permission));
  }

  allows(actor: string | undefined, permission: string): boolean {
    return (
      actor !== undefined && (this.granted.get(actor)?.has(permission) ?? false)
    );
  }
}

@Aspect({ order: 0 })
export class PermissionAspect {
  constructor(
    private readonly actor: Actor,
    private readonly permissions: Permissions,
  ) {}

  @Before(guarded)
  check(joinPoint: JoinPointOf<typeof guarded>): void {
    const actor = this.actor.current();
    const permission = joinPoint.annotation(RequiresPermission);
    if (!this.permissions.allows(actor, permission)) {
      throw new ForbiddenException(
        `${actor ?? "anonymous"} lacks ${permission}`,
      );
    }
  }
}
```

A call without an actor is denied. On an asynchronous method, the error of before advice rejects the promise of the call:

```ts
const checkout = app.get(CheckoutService);
app.get(Permissions).grant("support-agent", "payments:refund");

const refund = await actor.run("support-agent", () =>
  checkout.refund("order-1", "charge-1"),
);
const denied = await checkout
  .refund("order-1", "charge-1")
  .catch((error) => error);
// refund: the result of PaymentClient.refund
// denied: ForbiddenException "anonymous lacks payments:refund"; PaymentClient.refund is not called
```

The alternative is a `this.permissions.require("payments:refund")` line at the top of each method. The annotation adds two checks to it: `requiresAdvice` keeps an application that lacks `PermissionAspect` from starting with its guarded methods open, and [the inspector](#inspection) lists every guarded member.

### After returning

After-returning advice receives the result of a normal completion as its second parameter: for a method that returns a promise, the value the promise resolves to. An error the advice throws propagates instead of the result. This aspect evicts a cached value after the write that changes it has succeeded; a failed write evicts nothing.

```ts
import { Logger } from "@nestjs/common";
import { AfterReturning, Aspect, type JoinPointOf } from "nestjs-aspect";

@Aspect({ order: 50 })
export class CacheEvictionAspect {
  private readonly logger = new Logger(CacheEvictionAspect.name);

  constructor(private readonly cache: Cache) {}

  @AfterReturning(evicting)
  async evict(joinPoint: JoinPointOf<typeof evicting>): Promise<void> {
    const key = joinPoint.annotation(Evicts)(...joinPoint.args);
    try {
      await this.cache.del(key);
    } catch (error) {
      this.logger.warn(`Cannot evict ${key}: ${error}`);
    }
  }
}
```

- The advice catches a failure of the cache: the write has succeeded, and its caller receives no error for the eviction.
- With `order: 50` the aspect is outside a transaction aspect of order 100, so the eviction follows the commit. A `this.cache.del(key)` line inside a transactional method runs before the commit, and a concurrent reader caches the old value again.
- `CacheInterceptor` caches the responses of GET route handlers. It does not evict when a service method writes.

### After throwing

After-throwing advice receives the error of the join point: a thrown error or the rejection of its promise. With `throwing`, it runs only for errors that are `instanceof` that class. The same error propagates after the advice; an error the advice throws replaces it. It is not a catch block: the caller still receives an error. This aspect gives every method of the clients one error class for a remote service that did not answer.

```ts
import { AfterThrowing, Aspect, type JoinPointOf } from "nestjs-aspect";

export class UpstreamUnavailableError extends TransientError {}

@Aspect({ order: 30 })
export class UpstreamErrorAspect {
  @AfterThrowing(clients, { throwing: TransportError })
  translate(
    joinPoint: JoinPointOf<typeof clients>,
    error: TransportError,
  ): never {
    const { targetType, name } = joinPoint.signature;
    throw new UpstreamUnavailableError(
      `${targetType.name}.${String(name)} did not answer`,
      { cause: error },
    );
  }
}
```

- `UpstreamUnavailableError` names the client method and keeps the transport error as its `cause`. It is a `TransientError`, so `RetryAspect` repeats the call.
- Every other error of a client, such as a rejection by the remote service, propagates unchanged.
- An exception filter maps an error to a response at a handler. It does not translate an error between two providers.

The alternative is a `try`/`catch` with the same mapping in every client method.

### After

After advice runs when the join point has finished, whether it returned or failed, like a `finally` block. For an asynchronous join point it runs when the promise settles. An error the advice throws replaces the outcome. This aspect counts the client calls in flight, and the provider that holds the count delays the shutdown of the application until they have settled. Without it, a deployment that stops the process cuts off the remote call a job has started.

```ts
import { type BeforeApplicationShutdown, Injectable } from "@nestjs/common";
import { After, Aspect, Before } from "nestjs-aspect";

@Injectable()
export class InFlightCalls implements BeforeApplicationShutdown {
  private count = 0;

  private drained?: () => void;

  enter(): void {
    this.count += 1;
  }

  leave(): void {
    this.count -= 1;
    if (this.count === 0) {
      this.drained?.();
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (this.count > 0) {
      await new Promise<void>((resolve) => {
        this.drained = resolve;
      });
    }
  }
}

@Aspect({ order: 10 })
export class DrainAspect {
  constructor(private readonly calls: InFlightCalls) {}

  @Before(clientCalls)
  enter(): void {
    this.calls.enter();
  }

  @After(clientCalls)
  leave(): void {
    this.calls.leave();
  }
}
```

- Within one aspect, before advice is outside after advice: every `enter` is followed by its `leave`, also when the call fails.
- The pointcut is `clientCalls`, not `clients`. A pair of before and after advice needs a result that settles exactly once, and the after advice of an Observable that is never subscribed does not run.
- With `order: 10` the aspect is outside `RetryAspect`: a call counts once and stays in flight through its retries.
- The wait has no time limit of its own; the termination grace period of the platform bounds it.

The alternative is a `try`/`finally` with the two calls in every client method.

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
    const { attempts, backoffMilliseconds } = joinPoint.annotation(Retryable);
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await joinPoint.proceed();
      } catch (error) {
        if (!(error instanceof TransientError) || attempt >= attempts) {
          throw error;
        }
        const ceiling = backoffMilliseconds * 2 ** (attempt - 1);
        await new Promise((resolve) =>
          setTimeout(resolve, Math.random() * ceiling),
        );
      }
    }
  }
}
```

- The aspect repeats a call only after a `TransientError`. A programming error, a validation error or a rejection by the remote service is not repeated.
- Before each further attempt it waits a random time below a ceiling that doubles with every attempt, which spreads the retries of concurrent callers.
- A repeated call must be safe to repeat. `PaymentClient.charge` sends the same idempotency key on every attempt; `ShippingClient.book` has no key and no annotation.
- A `retry(() => ...)` helper at the call site is equivalent for a single call. The aspect is the simpler form where the retry has to surround other advice: the [transaction recipe](#a-transaction-around-a-service-method) repeats a whole transaction.

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
| `joinPoint.toString()`                                  | `'ShippingClient.quote("Lisbon")'`: the member and every argument of the call.                                |
| `joinPoint.proceed()`, `joinPoint.proceedWith(...args)` | Around advice only.                                                                                           |

Annotation lookups read the method, then the declaring class, then the target class.

The compiler rejects an annotation on a method outside its contract, a missing or mistyped annotation value, around advice with the wrong return type, `proceedWith` arguments that do not fit the method, an after-returning result or after-throwing error parameter of the wrong type, asynchronous advice on a join point known to be synchronous, and `P.method` with a name that is not a method of the class.

## Recipes

Each recipe advises calls that no Nest enhancer surrounds. The recipes use the annotations and `RetryAspect` of the sections above.

### A transaction around a service method

An interceptor can open a transaction only around a whole route handler, and not at all for a method that a job or another service calls. The aspect delimits the transaction at the service method, and an `AsyncLocalStorage` carries it to the repositories the method calls.

`DatabaseClient` stands for the database client of the application and is provided by `InfrastructureModule`. Its `transaction` is the transaction callback of the client, such as `$transaction` of Prisma, `transaction` of a TypeORM `DataSource` or `transaction` of Drizzle, and a `Connection` is what a repository runs its statements on.

```ts
export interface TransactionOptions {
  isolation?: "read committed" | "serializable";
}

export interface Connection {
  get(key: string): Promise<number | undefined>;

  set(key: string, value: number): Promise<void>;
}

export abstract class DatabaseClient implements Connection {
  abstract get(key: string): Promise<number | undefined>;

  abstract set(key: string, value: number): Promise<void>;

  abstract transaction<T>(
    work: (transaction: Connection) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T>;
}
```

`Database` is the provider an application writes around its client. `transactional` joins the active transaction or begins one, and `connection` is the transaction of the current call, or the client outside a transaction. A transaction that the database has ended because of a conflict fails with a `TransientError`: `40001` and `40P01` are the PostgreSQL codes of a serialization failure and of a deadlock.

```ts
import { AsyncLocalStorage } from "node:async_hooks";
import { Injectable } from "@nestjs/common";

const conflicts = new Set(["40001", "40P01"]);

@Injectable()
export class Database {
  private readonly active = new AsyncLocalStorage<Connection>();

  constructor(private readonly client: DatabaseClient) {}

  get connection(): Connection {
    return this.active.getStore() ?? this.client;
  }

  async transactional<T>(
    work: () => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T> {
    if (this.active.getStore()) {
      return work();
    }
    try {
      return await this.client.transaction(
        (transaction) => this.active.run(transaction, work),
        options,
      );
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (typeof code === "string" && conflicts.has(code)) {
        throw new TransientError("The transaction lost a conflict", {
          cause: error,
        });
      }
      throw error;
    }
  }
}
```

The annotation carries the options of the transaction, and the aspect passes them on:

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
  TransactionOptions,
  (...args: any[]) => Promise<unknown>
>("Transactional", { requiresAdvice: true });

export const transactional = P.annotated(Transactional).or(
  P.withinAnnotated(Transactional).and(asynchronous),
);

@Aspect({ order: 100 })
export class TransactionAspect {
  constructor(private readonly database: Database) {}

  @Around(transactional)
  run(
    joinPoint: ProceedingJoinPointOf<typeof transactional>,
  ): Promise<unknown> {
    return this.database.transactional(
      async () => joinPoint.proceed(),
      joinPoint.findAnnotation(Transactional),
    );
  }
}
```

- `transactional` selects the methods that carry `@Transactional({})`, a transaction with the defaults of the database, and the asynchronous methods of a class that carries the annotation. `joinPoint.findAnnotation(Transactional)` reads the options from the method, then from its class.
- An annotated class begins a transaction for each of its asynchronous methods, its reads included, and each holds a connection for the length of the call. Annotate a class whose methods are all writes; annotate the methods otherwise.
- `requiresAdvice` keeps an annotated method from running without a transaction: when `TransactionAspect` is not registered, the application fails to initialize, and a call of the method raises `AspectConfigurationError` in every mode.
- A call inside an active transaction joins it.
- The `AsyncLocalStorage` follows the asynchronous work the method awaits. Work it does not await, such as a promise it leaves pending or a listener that runs later, still finds the connection of a transaction that has ended.

The repository obtains its connection from `Database` and knows nothing of the transaction. `add` reads a balance and writes the sum, which is correct only when no other transaction changes the row in between. `WalletService` therefore asks for serializable isolation, under which the database fails one of two transactions that have read the same balance, and `@Retryable` has `RetryAspect` of [Around](#around) repeat the one that failed.

```ts
import { Injectable, Module } from "@nestjs/common";
import { AspectModule } from "nestjs-aspect";

export class InsufficientFundsError extends Error {}

@Injectable()
export class WalletRepository {
  constructor(private readonly database: Database) {}

  async balance(owner: string): Promise<number> {
    return (await this.database.connection.get(owner)) ?? 0;
  }

  async add(owner: string, amount: number): Promise<void> {
    const balance = (await this.balance(owner)) + amount;
    if (balance < 0) {
      throw new InsufficientFundsError(`${owner} cannot pay ${-amount}`);
    }
    await this.database.connection.set(owner, balance);
  }
}

@Injectable()
@Transactional({ isolation: "serializable" })
export class WalletService {
  constructor(private readonly wallets: WalletRepository) {}

  @Retryable({ attempts: 3, backoffMilliseconds: 50 })
  async deposit(owner: string, amount: number): Promise<void> {
    await this.wallets.add(owner, amount);
  }

  @Retryable({ attempts: 3, backoffMilliseconds: 50 })
  async move(from: string, to: string, amount: number): Promise<void> {
    await this.wallets.add(from, -amount);
    await this.wallets.add(to, amount);
  }
}

@Module({
  imports: [AspectModule.forRoot(), InfrastructureModule],
  providers: [
    Database,
    TransactionAspect,
    RetryAspect,
    WalletRepository,
    WalletService,
  ],
})
export class WalletModule {}
```

`RetryAspect` has order 20 and `TransactionAspect` order 100. The lower order is the outer advice, so each attempt runs in a new transaction. Two concurrent transfers read the balance of `alice`: the first to commit wins, the second fails its commit, rolls back and runs again in a third transaction, which reads the new balance.

```ts
const app = await NestFactory.createApplicationContext(WalletModule);
const service = app.get(WalletService);
const wallets = app.get(WalletRepository);

await service.deposit("alice", 25);
await Promise.all([
  service.move("alice", "bob", 10),
  service.move("alice", "carol", 10),
]);

const balances = [
  await wallets.balance("alice"),
  await wallets.balance("bob"),
  await wallets.balance("carol"),
];
// balances: [5, 10, 10]
// transactions of the two transfers: begin, begin, commit, rollback, begin, commit
```

Without the aspects, each method wraps its body in `retry(() => this.database.transactional(() => ...))`. For one or two methods that is the simpler form. Nothing checks that every method nests the two helpers in this order: with the retry inside, each attempt runs in the transaction that has already failed. [Ordering](#ordering) pins the order of the two aspects in a test.

### Jobs outside the request pipeline

A method that a timer, a scheduler, an event emitter or a queue worker calls is no handler: no guard, no interceptor and no exception filter surrounds it. The aspect gives every scheduled method what the request pipeline gives a handler and what a job needs besides: an identity, one running instance among the replicas of the application, and a report of its failure. It selects the methods by the decorator of the scheduler, so a job carries no second decorator.

```ts
export abstract class JobLocks {
  abstract acquire(name: string): Promise<(() => Promise<void>) | undefined>;
}

export abstract class ErrorReporter {
  abstract report(source: string, error: unknown): Promise<void>;
}
```

`JobLocks` stands for a lock the replicas share, such as an advisory lock of the database: `acquire` resolves to the function that releases the lock, or to `undefined` when another replica holds it. `ErrorReporter` stands for the client of an error tracker. `InfrastructureModule` provides both.

```ts
import { Logger } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import {
  Around,
  Aspect,
  Pointcut as P,
  type ProceedingJoinPointOf,
} from "nestjs-aspect";

export const Scheduled = Reflector.createDecorator<{
  name: string;
  everyMilliseconds: number;
}>();

export const scheduled = P.annotated(Scheduled);

@Aspect()
export class JobAspect {
  private readonly logger = new Logger(JobAspect.name);

  constructor(
    private readonly actor: Actor,
    private readonly locks: JobLocks,
    private readonly reporter: ErrorReporter,
  ) {}

  @Around(scheduled)
  async run(
    joinPoint: ProceedingJoinPointOf<typeof scheduled>,
  ): Promise<unknown> {
    const name =
      joinPoint.findAnnotation(Scheduled)?.name ??
      String(joinPoint.signature.name);
    const release = await this.locks.acquire(name);
    if (!release) {
      return undefined;
    }
    try {
      return await this.actor.run(`job:${name}`, async () =>
        joinPoint.proceed(),
      );
    } catch (error) {
      await this.reporter
        .report(name, error)
        .catch((failure) =>
          this.logger.warn(`Cannot report the failure of ${name}: ${failure}`),
        );
      throw error;
    } finally {
      await release();
    }
  }
}
```

- `Scheduled` stands in for the decorator of a scheduling package, and `Scheduler` of `SchedulerModule` for its scheduler, which calls every method that carries the decorator on a timer. `P.annotated` accepts a decorator made with `Reflector.createDecorator()`; `P.metadata(key)` selects the methods of a decorator that stores its metadata under another key.
- A replica that does not get the lock skips the run.
- The job runs as the actor `job:<name>`. `PermissionAspect` of [Before](#before) checks the permissions of that actor on the service methods the job calls, and `AuditAspect` of the [Quick start](#quick-start) records it.
- The advice reports the failure and rethrows it, so the scheduler, or the queue worker in its place, still sees the rejection. A failure of the reporter is logged and does not replace the error of the job.

The job itself holds its work and nothing else. It stores the prices of a supplier through `CatalogService.reprice` of [the example application](#the-example-application), which requires the permission `catalog:write`:

```ts
import { Injectable, Module } from "@nestjs/common";
import { AspectModule } from "nestjs-aspect";

@Injectable()
export class PriceSyncJob {
  constructor(
    private readonly transport: Transport,
    private readonly catalog: CatalogService,
  ) {}

  @Scheduled({ name: "price-sync", everyMilliseconds: 60_000 })
  async sync(): Promise<void> {
    const prices = await this.transport.send<Record<string, number>>(
      "supplier/prices",
      {},
    );
    for (const [sku, price] of Object.entries(prices)) {
      await this.catalog.reprice(sku, price);
    }
  }
}

@Module({
  imports: [
    AspectModule.forRoot(),
    ShopModule,
    SchedulerModule,
    InfrastructureModule,
  ],
  providers: [
    Actor,
    Permissions,
    PermissionAspect,
    RetryAspect,
    CacheEvictionAspect,
    JobAspect,
    PriceSyncJob,
  ],
})
export class JobsModule {}
```

`scheduler.fire(name)` runs a job as its timer does. The supplier answers the first request and not the second:

```ts
const app = await NestFactory.createApplicationContext(JobsModule);
const scheduler = app.get(Scheduler);
app.get(Permissions).grant("job:price-sync", "catalog:write");

await scheduler.fire("price-sync");
const price = await app.get(CatalogService).price("widget");

const release = await app.get(JobLocks).acquire("price-sync");
await scheduler.fire("price-sync");
await release?.();

const failure = await scheduler.fire("price-sync").catch((error) => error);
// price: 12, stored by the actor "job:price-sync"
// the second run finds the lock held and sends no request
// failure: the TransportError of the third run, which the reporter has received
```

A plain method decorator cannot do this: it runs outside the container and reaches the lock, the reporter and the actor only through global state. The explicit form is a `runJob(name, () => ...)` call of an injected service in every job, which the job added next can omit.

A message handler of a Nest microservice (`@MessagePattern`, `@EventPattern`) is a handler: it has the enhancer chain, and an exception filter is the tool there.

### Timing every repository of a module

An interceptor times a handler. No enhancer reaches the repositories behind it, a decorator on every repository method leaves out the method added next, and a `Proxy` around each repository replaces its class provider with a factory and misses the calls a repository makes on itself. The pointcut selects the asynchronous methods of every provider of `PersistenceModule` whose token ends in `Repository`; the repositories carry no decorator. `asynchronous` of [Pointcuts](#pointcuts) keeps the advice, which awaits `proceed()`, away from synchronous methods. The recipe measures the repositories an application writes; the queries of a database driver are measured by the instrumentation of that driver.

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
    if (name === "") {
      throw new RangeError("A name is required");
    }
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

export const repositoryCalls = P.all(
  P.inModule(PersistenceModule),
  P.bean("*Repository"),
  asynchronous,
);

export interface CallTotals {
  calls: number;
  errors: number;
  milliseconds: number;
}

@Injectable()
export class CallStatistics {
  private readonly totals = new Map<string, CallTotals>();

  record(member: string, failed: boolean, milliseconds: number): void {
    const totals = this.totals.get(member) ?? {
      calls: 0,
      errors: 0,
      milliseconds: 0,
    };
    totals.calls += 1;
    totals.errors += failed ? 1 : 0;
    totals.milliseconds += milliseconds;
    this.totals.set(member, totals);
  }

  summary(): Record<string, CallTotals> {
    return Object.fromEntries(this.totals);
  }
}

@Aspect()
export class RepositoryTimingAspect {
  constructor(private readonly statistics: CallStatistics) {}

  @Around(repositoryCalls)
  async time(
    joinPoint: ProceedingJoinPointOf<typeof repositoryCalls>,
  ): Promise<unknown> {
    const { targetType, name } = joinPoint.signature;
    const member = `${targetType.name}.${String(name)}`;
    const started = performance.now();
    let failed = true;
    try {
      const result = await joinPoint.proceed();
      failed = false;
      return result;
    } finally {
      this.statistics.record(member, failed, performance.now() - started);
    }
  }
}

@Module({
  imports: [AspectModule.forRoot(), PersistenceModule],
  providers: [CallStatistics, RepositoryTimingAspect],
})
export class ReportingModule {}
```

`CallStatistics` keeps one total per repository method, so it does not grow with the number of calls; an application records into the histogram of its metrics client instead. `UserRepository.size` is synchronous and `IdGenerator` is no repository, so neither is recorded:

```ts
const app = await NestFactory.createApplicationContext(ReportingModule);
const users = app.get(UserRepository);

await users.rename(1, "Ada");
await users.rename(1, "").catch(() => undefined);
await users.findName(1);
users.size();
await app.get(OrderRepository).findByUser(1);
await app.get(IdGenerator).next();

const summary = app.get(CallStatistics).summary();
// {
//   "UserRepository.rename": { calls: 2, errors: 1, milliseconds: ... },
//   "UserRepository.findName": { calls: 1, errors: 0, milliseconds: ... },
//   "OrderRepository.findByUser": { calls: 1, errors: 0, milliseconds: ... },
// }
```

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

`AspectModule.forRootAsync()` takes the options from a factory, a class or an existing provider. This module registers the providers of the [Quick start](#quick-start):

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
  providers: [Actor, AuditLog, AuditAspect, MemberService, ApiKeyService],
})
export class ConfiguredAppModule {}
```

The options come from singleton providers. The weaver waits for them inside the instantiation phase; a provider factory that runs before they are resolved calls its dependencies without advice.

## Ordering

- **Across aspects and advisors**, a lower `order` has the higher precedence: its advice runs first on the way in and last on the way out. One without an order has the lowest precedence. Aspects with equal orders, or without one, nest in registration order: the one registered first is the outer one. The weaver reports this as a warning when they advise the same member.
- **Within one aspect**, the advice kinds nest in this order from the outside in: around, before, after, after returning, after throwing. After advice therefore runs after the after-returning and after-throwing advice of its aspect. Advice of the same kind nests in declaration order: the first declared is the outermost, so before advice runs in declaration order, and after, after-returning and after-throwing advice in reverse declaration order.

The aspects of this README, from the outside in:

| Order | Aspect                                                        | Reason for its place                                                                        |
| ----- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 0     | `PermissionAspect`                                            | A call without the permission runs no other advice.                                         |
| 10    | `DrainAspect`                                                 | A call is in flight once, through its retries.                                              |
| 20    | `RetryAspect`                                                 | Each attempt passes the circuit breaker, the error translation and the transaction again.   |
| 25    | [`CircuitBreakerAspect`](#instantiation-models)               | The breaker counts every attempt, and its own error ends the retries.                       |
| 30    | `UpstreamErrorAspect`                                         | The breaker and the retry see the translated error.                                         |
| 50    | `CacheEvictionAspect`                                         | The eviction follows the commit.                                                            |
| 100   | [`TransactionAspect`](#a-transaction-around-a-service-method) | The transaction covers the body of the method and none of the waiting between two attempts. |

The order of two aspects decides what they do together: with `TransactionAspect` outside `RetryAspect`, every attempt runs in the transaction that has already failed. A test pins the chain of a method for which the order matters, here in the application of the [transaction recipe](#a-transaction-around-a-service-method):

```ts
const inspector = app.get(AspectInspector);
const chain = inspector
  .advisorsOf(WalletService, "move")
  .map(({ type, kind, order }) => `${type.name} ${kind} ${order}`);

expect(chain).toEqual([
  "RetryAspect around 20",
  "TransactionAspect around 100",
]);
```

Within one aspect that declares all five kinds of advice for a method, one call that returns leaves this trace:

```
around: before proceed
before
after returning
after
around: after proceed
```

## Asynchronous join points

- **Promises.** After-returning, after-throwing and after advice follow the settlement of a `Promise`, not the synchronous return of the promise object.
- **Asynchronous advice.** Before, after, after-returning and after-throwing advice can be `async` when the join point is or may be asynchronous; the settlement the caller sees waits for the advice. On a join point known to be synchronous, `async` advice is a compile error; where the types cannot tell, it raises `AspectUsageError` when called.
- **Asynchronous before advice** needs a method that is declared asynchronous: an `async` method, or a decorated method whose declared return type is `Promise`. A method that returns a promise without either counts as synchronous for before advice.
- **Other thenables**, such as a lazy query builder, are followed only when the method is declared asynchronous. Returned from any other method they reach the caller untouched and are not run.
- **Around advice** receives what `proceed()` returns, a promise for an asynchronous method, and awaits it when it needs the result.

### Observables

`observableAdapter` of the `nestjs-aspect/rxjs` entry lets advice follow an Observable. Register it in `returnValueAdapters`. The root entry does not load `rxjs`.

`ShippingClient.track` of [the example application](#the-example-application) returns a cold Observable: the request is sent at subscription, and its failure arrives as an error notification after the method has returned. With the adapter, `UpstreamErrorAspect` of [After throwing](#after-throwing) translates that error as it translates the rejection of a promise, so one aspect serves both kinds of client method. Without the adapter, the advice never sees the error.

```ts
import { Module } from "@nestjs/common";
import { AspectModule } from "nestjs-aspect";
import { observableAdapter } from "nestjs-aspect/rxjs";

@Module({
  imports: [
    AspectModule.forRoot({ returnValueAdapters: [observableAdapter] }),
    ShopModule,
  ],
  providers: [
    Actor,
    Permissions,
    PermissionAspect,
    RetryAspect,
    UpstreamErrorAspect,
  ],
})
export class TrackingModule {}
```

```ts
const app = await NestFactory.createApplicationContext(TrackingModule);

const updates = app.get(ShippingClient).track("shipment-1");
const lost = await lastValueFrom(updates).catch((error) => error);
// lost: UpstreamUnavailableError "ShippingClient.track did not answer"
```

An Observable is lazy, so the advice runs within each subscription:

- After-returning advice runs when the stream completes, with the last value it emitted or `undefined` when it emitted none. For a method that returns an Observable, the result parameter is typed `any`, so the advice declares the type of the emitted values itself.
- After-throwing advice runs on the error notification.
- After advice runs once when the subscription ends: at completion, at an error, or when the subscriber unsubscribes.
- A result that is never subscribed runs no after advice; a result that is subscribed twice runs it twice.
- Before advice and the code of around advice run when the method is called, not at subscription. Advice that pairs a before with an after, measures a duration or retries does not fit a method that returns an Observable.

### Other result types

A `ReturnValueAdapter` makes advice follow a result that settles after the method has returned and is neither a promise nor an Observable. An `async` generator method returns its generator before it has produced a value: without an adapter, after advice runs at that moment and after-throwing advice never sees an error that a later iteration raises. `PaymentClient.settlements` is such a method: it requests the next page while its caller iterates. This adapter follows a generator to its end:

```ts
import type { ReturnValueAdapter } from "nestjs-aspect";

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
```

- `supports` decides by value which results the adapter follows; adapters are consulted in the order of the option, before the built-in `promiseAdapter`. This one recognizes the generator of an `async function*`. Another async iterable, such as a `Readable`, is not followed.
- `onSuccess` calls `callback` with the value after-returning advice receives, `onError` with the error, and `finally` without an argument. Each returns a result of the same type and waits for what `callback` returns.
- After-returning advice runs when the consumer has read the last item, and receives that item. After advice also runs when the consumer leaves the loop early. Like an Observable, a generator that is never iterated runs no after advice.

Registered next to `observableAdapter`, the adapter has `UpstreamErrorAspect` translate the transport error of a later page:

```ts
@Module({
  imports: [
    AspectModule.forRoot({
      returnValueAdapters: [observableAdapter, asyncGeneratorAdapter],
    }),
    ShopModule,
  ],
  providers: [
    Actor,
    Permissions,
    PermissionAspect,
    RetryAspect,
    UpstreamErrorAspect,
  ],
})
export class StreamingModule {}
```

```ts
const app = await NestFactory.createApplicationContext(StreamingModule);

const settlements: string[] = [];
let failure: unknown;
try {
  for await (const settlement of app
    .get(PaymentClient)
    .settlements("2026-10-12")) {
    settlements.push(settlement);
  }
} catch (error) {
  failure = error;
}
// settlements: the items of the first page
// failure: UpstreamUnavailableError "PaymentClient.settlements did not answer", raised for the second page
```

## Scopes, self-invocation and the request pipeline

- **Targets of every scope are advised**: singleton, request-scoped and transient.
- **Aspects and advisors are singletons.** One that is request-scoped or transient, by its own scope or because it depends on a request-scoped provider, is rejected when the application initializes. Per-request state belongs to the join point. Advice has no request object, so the route that works for every call is an `AsyncLocalStorage`: a middleware or a guard stores the user or the tenant of the request, and the advice reads the store, also in the calls a job makes inside its own store. `Actor` of the [Quick start](#quick-start) is such a provider. `ModuleRef.resolve()` needs a context id, which `ContextIdFactory.getByRequest()` derives from the request: advice can use it only where the target exposes the request, as a request-scoped provider that injects `REQUEST` does.
- **Aspects and advisors are never advised.** An aspect inherits the advice of a superclass without `@Aspect`; an aspect that extends another `@Aspect` class is rejected.
- **Self-invocation is advised.** A call from a method to another method of the same object (`this.other()`) runs the advice of that method, unlike in Spring: the dispatcher is the member on the class prototype, not a proxy in front of the object.
- **Controllers.** On a route handler, advice runs inside the Nest interceptors and after the pipes, so it sees the transformed arguments:

  ```
  middleware -> guards -> interceptors -> pipes -> [ advice -> route handler ] -> interceptors -> exception filters
  ```

  An error thrown by advice reaches the exception filters like an error of the handler. Route metadata and `SetMetadata` values stay visible on a woven handler.

## Advisors

`@Advisor()` marks a provider as an advisor: one pointcut and one advice, the layer aspects compile to. The static member `pointcut` selects the join points; an instance supplies `advice`, a `MethodInterceptor`, and an optional `order`. An application states its advice as aspects. An advisor is the form for code that holds advice as an object, such as a package that ships a `MethodInterceptor`. This advisor does what `TransactionAspect` of the [transaction recipe](#a-transaction-around-a-service-method) does, with the pointcut, the annotation and the `Database` of that recipe:

```ts
import { Advisor, type MethodInterceptor } from "nestjs-aspect";

@Advisor()
export class TransactionAdvisor {
  static readonly pointcut = transactional;

  readonly order = 100;

  readonly advice: MethodInterceptor = {
    invoke: (invocation) =>
      this.database.transactional(
        async () => invocation.proceed(),
        invocation.joinPoint.findAnnotation(Transactional),
      ),
  };

  constructor(private readonly database: Database) {}
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

A `perClass` aspect holds the state of one advised class in plain fields. This circuit breaker counts the transient failures of each client class of [the example application](#the-example-application) and, from the third in a row, rejects the calls of that class for a while. A remote service that is down is then not called for every request, and the breaker of one client leaves the other client alone. A singleton aspect holds the same state in a `Map` keyed by `joinPoint.signature.targetType`.

```ts
import { Injectable } from "@nestjs/common";
import { Around, Aspect, type ProceedingJoinPointOf } from "nestjs-aspect";

@Injectable()
export class BreakerSettings {
  readonly threshold = 3;

  readonly coolDownMilliseconds = 30_000;
}

export class CircuitOpenError extends Error {}

@Aspect({ instantiation: "perClass", order: 25 })
export class CircuitBreakerAspect {
  private failures = 0;

  private openUntil = 0;

  constructor(private readonly settings: BreakerSettings) {}

  @Around(clientCalls)
  async guard(
    joinPoint: ProceedingJoinPointOf<typeof clientCalls>,
  ): Promise<unknown> {
    if (Date.now() < this.openUntil) {
      const { targetType } = joinPoint.signature;
      throw new CircuitOpenError(`${targetType.name} is unavailable`);
    }
    try {
      const result = await joinPoint.proceed();
      this.failures = 0;
      return result;
    } catch (error) {
      if (error instanceof TransientError) {
        this.failures += 1;
        if (this.failures >= this.settings.threshold) {
          this.openUntil = Date.now() + this.settings.coolDownMilliseconds;
        }
      }
      throw error;
    }
  }
}
```

- The breaker opens when the transient failures since the last success reach `threshold`. After `coolDownMilliseconds` the calls pass again: a success closes the breaker, and the next failure opens it for another period.
- With order 25 the breaker is inside `RetryAspect` and outside `UpstreamErrorAspect`: it counts the translated error of every attempt, and `CircuitOpenError`, which is no `TransientError`, ends the retries.

An instance of a `perTarget` or `perClass` aspect is created during a call, with the singleton providers its constructor and `@Inject()` properties name. A dependency that is request-scoped, transient or missing is rejected when the application initializes.

## Introductions

`@DeclareParents` declares that the classes a pointcut or class filter selects implement another interface, and names the class that implements it. The decorator applies to a static member of an aspect whose type is the interface: an abstract class, because a TypeScript interface leaves no value at run time.

```ts
import { Aspect, DeclareParents, Pointcut as P } from "nestjs-aspect";

export abstract class Lockable {
  abstract lock(): void;

  abstract get locked(): boolean;
}

export class DefaultLockable implements Lockable {
  private isLocked = false;

  lock(): void {
    this.isLocked = true;
  }

  get locked(): boolean {
    return this.isLocked;
  }
}

@Aspect()
export class LockableAspect {
  @DeclareParents(P.within(ProductRepository), { use: DefaultLockable })
  static readonly mixin: Lockable;
}
```

The methods and accessors of `DefaultLockable` become members of every `ProductRepository`. Each object has its own delegate, created without arguments on first use. `isIntroduced` narrows an object to the introduced interface, `introduced(object, Token)` returns the delegate, and advice reaches it with `joinPoint.introduced(Token)`:

```ts
const products = app.get(ProductRepository);
if (isIntroduced(products, Lockable)) {
  products.lock();
}
const locked = introduced(products, Lockable).locked;
```

- An introduction applies to whole classes: of a pointcut, only the class filter is used.
- A member the class already has, or that another introduction adds, raises `AspectConfigurationError` while the module compiles, unless the introduction sets `override: true`.
- Introduced members are not advised.
- The type of a class does not show its introduced members. A member the class can declare itself, or reach through a provider it injects, belongs there.

## Inspection

`AspectInspector` is a provider `AspectModule` exports globally. It lists what the application advises. A test pins the members a structural pointcut selects, here those of `clients` through `UpstreamErrorAspect`, so a client method that joins or leaves the selection changes the test:

```ts
const inspector = app.get(AspectInspector);
const selected = inspector
  .advisedMembers()
  .filter(({ advisors }) =>
    advisors.some(({ type }) => type === UpstreamErrorAspect),
  )
  .map(({ type, name }) => `${type.name}.${String(name)}`);

expect(selected).toEqual([
  "PaymentClient.charge",
  "PaymentClient.refund",
  "PaymentClient.settlements",
  "ShippingClient.quote",
  "ShippingClient.book",
  "ShippingClient.track",
]);
```

- `advisedMembers(type?)` returns every advised member of the application or of one class: `{ type, declaringType, name, kind, advisors }`.
- `advisorsOf(type, name, kind?)` returns the advisors of one member in the order their advice runs: `{ type, methodName?, kind?, order }`, where `type` is the aspect or advisor class. [Ordering](#ordering) pins the chain of a method with it.
- It reports static matches: an advisor with `P.args` is listed for every member it may advise. It lists nothing after the application has shut down.

When the application initializes, the weaver logs the same information as the **weaving report** through the Nest `Logger`, with the context `AspectModule` and at the level of the `report` option. One line names a member and one advisor, in chain order. This is the report of the [Quick start](#quick-start):

```
MemberService.invite <- AuditAspect.succeeded (afterReturning, no order)
MemberService.invite <- AuditAspect.failed (afterThrowing, no order)
MemberService.remove <- AuditAspect.succeeded (afterReturning, no order)
MemberService.remove <- AuditAspect.failed (afterThrowing, no order)
ApiKeyService.revoke <- AuditAspect.succeeded (afterReturning, no order)
ApiKeyService.revoke <- AuditAspect.failed (afterThrowing, no order)
```

## Testing

Weaving happens while the module compiles, so advice runs after `compile()` without `init()`. The bootstrap validation, the weaving report and the weaving of factory and value provider instances run in `init()`. This test of `AuditAspect` compiles the module of the [Quick start](#quick-start) with a stand-in for the provider the aspect writes to:

```ts
describe("AuditAspect", () => {
  let moduleRef: TestingModule;
  const record = vi.fn();

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AuditLog)
      .useValue({ record })
      .compile();
  });

  afterEach(() => moduleRef.close());

  it("records who invited a member", async () => {
    await moduleRef
      .get(Actor)
      .run("alice", () =>
        moduleRef.get(MemberService).invite("member-7", "editor"),
      );

    expect(record).toHaveBeenCalledWith({
      action: "member.invite",
      actor: "alice",
      subject: "member-7",
      outcome: "ok",
    });
  });
});
```

Close each application or testing module: `close()` detaches it from the woven classes. An object created with `new` runs its original methods when no live application advises its class. A unit test of `WalletService` of the [transaction recipe](#a-transaction-around-a-service-method) passes a stub and gets no transaction, no retry and no `AspectConfigurationError`:

```ts
const add = vi.fn();
const service = new WalletService({ add } as unknown as WalletRepository);

await service.move("alice", "bob", 10);

expect(add.mock.calls).toEqual([
  ["alice", -10],
  ["bob", 10],
]);
```

- **Unmanaged instances.** While exactly one live application advises a class, an object of that class created with `new` is advised by that application.
- **Several applications in one process** stay apart. An instance is advised by the application whose container created it, also when that application excludes the class or matches nothing in it, and an instance of a closed application is not advised by a later one. An object that a container only holds, as the instance of a `useValue` or `useFactory` provider, belongs to that application while the application advises its class.
- **Ambiguous objects.** When several live applications advise a class and nothing tells which of them an object belongs to, as for an object created with `new`, a call raises `AspectUsageError`. With `strict: false` in each of those applications, the most recently created one advises the object and logs a warning. An application that is never closed stays live as long as one of its instances is reachable, so close the modules of earlier tests.
- **Replaced aspects.** An aspect replaced with `overrideProvider(...).useValue(...)` is no aspect any more: its advice does not run, and a member whose annotation requires that advice is treated like one whose aspect is not registered. Replace the providers an aspect depends on instead.
- **A service with `requiresAdvice` annotations.** A test of the service inside a testing module registers the aspect with it.

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
| `args(String, *, ..)`                                               | `P.args(String, P.ANY, P.REST)`                                          |
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
