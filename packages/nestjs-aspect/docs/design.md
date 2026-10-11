# nestjs-aspect - Design

This document explains aspect-oriented programming, how Spring AOP implements it, which parts of that model `nestjs-aspect` adopts unchanged, where the platform forces a different mechanism, and how the library behaves at run time. The [README](../README.md) is the user guide; this document is the specification behind it.

Contents:

1. [Aspect-oriented programming](#1-aspect-oriented-programming)
2. [Design philosophy, goals and non-goals](#2-design-philosophy-goals-and-non-goals)
3. [How Spring AOP works](#3-how-spring-aop-works)
4. [What nestjs-aspect adopts from Spring](#4-what-nestjs-aspect-adopts-from-spring)
5. [Platform constraints and the weaving strategy](#5-platform-constraints-and-the-weaving-strategy)
6. [Deliberate differences from Spring](#6-deliberate-differences-from-spring)
7. [Runtime semantics](#7-runtime-semantics)
8. [Spring feature coverage](#8-spring-feature-coverage)
9. [Accepted limitations and open questions](#9-accepted-limitations-and-open-questions)

---

## 1. Aspect-oriented programming

### 1.1 Crosscutting concerns

Object-oriented design decomposes a program into classes, each responsible for one part of the domain. Some requirements do not follow that decomposition. Transaction boundaries, retries, audit trails, access checks, caching, metrics and tracing apply to many methods of many unrelated classes, and the rule that decides where they apply ("every method of the service layer", "every method marked as retryable") is independent of any single class. Such a requirement is a _crosscutting concern_.

Implemented inside the classes, a crosscutting concern produces two defects:

- **Scattering**: the same logic is repeated in every method it applies to.
- **Tangling**: each method mixes its own responsibility with the logic of several concerns, so neither can change without touching the other.

Aspect-oriented programming (AOP) gives a crosscutting concern a module of its own. The concern is written once, together with a declarative statement of where it applies, and a framework connects it to the code it concerns. AOP complements object-oriented programming: classes remain the unit of the domain, and aspects become the unit of the concerns that cut across it.

### 1.2 Terms

| Term              | Definition                                                                                                                                                                                                                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Aspect**        | The module of one crosscutting concern. It holds the behavior of the concern (advice) and the statement of where it applies (pointcuts). In `nestjs-aspect` an aspect is a class decorated with `@Aspect()`, which is also a Nest provider.                                                                                                                  |
| **Join point**    | A point in the execution of a program at which behavior can be added. The general model includes field access, constructor calls and exception handlers; Spring AOP supports method execution only. In `nestjs-aspect` a join point is the execution of a method or of an accessor (getter or setter) that a class prototype defines.                        |
| **Advice**        | The action an aspect takes at a join point, together with the time at which it runs relative to the join point: before it, after it returns, after it throws, after it in any case, or around it. Advice is implemented as an interceptor, and the framework keeps a chain of interceptors around each join point.                                           |
| **Pointcut**      | A predicate over join points. Advice is bound to a pointcut and runs at every join point the pointcut matches. The decisive property of a pointcut is that it is independent of the class hierarchy: it selects by name, by annotation, by module or by argument, in classes that know nothing about the aspect.                                             |
| **Introduction**  | The declaration of additional members on behalf of a type: an aspect states that the classes a filter selects implement another interface, and supplies the implementation. AspectJ calls this an inter-type declaration.                                                                                                                                    |
| **Target object** | The object a join point executes on, which is the object being advised. In Spring the target is hidden behind a proxy; in `nestjs-aspect` the target is the object the caller holds.                                                                                                                                                                         |
| **Weaving**       | Linking aspects to the code they advise. It can happen at compile time, at class load time or at run time. Spring AOP weaves at run time by creating proxy objects. `nestjs-aspect` weaves at run time by replacing members of class prototypes while the Nest container instantiates its providers.                                                         |
| **Advisor**       | One advice together with one pointcut: the smallest self-contained unit of an aspect. The term comes from Spring, where every advice method of an aspect becomes one advisor internally and where infrastructure features are written as advisors directly. `nestjs-aspect` uses the same model: aspects compile to advisors, and `@Advisor()` declares one. |

Two further terms describe matching:

- **Static matching** decides from the class and the member alone, once, when the class is woven.
- **Dynamic matching** needs the arguments of a call and is therefore evaluated on every call of a member that matched statically.

---

## 2. Design philosophy, goals and non-goals

### 2.1 Philosophy

`nestjs-aspect` implements the Spring AOP model on NestJS. Where a decision arises, the Spring convention applies; the library deviates only where the platform (TypeScript, Node.js, the Nest container) makes the Spring behavior impossible or wrong, and section 6 lists every such deviation with its reason.

### 2.2 Goals

1. **Non-invasive pointcuts that are independent of the class hierarchy.** An aspect selects join points in classes that do not import it, do not extend a base class for it and carry no decorator for it. Pointcuts match by class, member name, member kind, module, provider token, Reflect metadata and arguments. Annotations are one designator among several, not a requirement.
2. **Type safety from the pointcut to the advice signature to the decorated method.** A pointcut carries the target type, the argument types, the return type and the annotations it guarantees. The advice decorators check the advice method against them, and an annotation can declare the method contract it accepts, so applying it to a method outside that contract is a compile error.
3. **Advice that is correct for asynchronous code.** After-returning, after-throwing and after advice follow the settlement of a promise instead of the synchronous return of the promise object. Other asynchronous types, such as Observables, are supported through an adapter interface.
4. **Deterministic behavior, with errors at bootstrap instead of silent no-ops.** The weaving time is defined, the advice order is defined in every case, and a configuration in which advice would silently not run fails the bootstrap or fails the call: an annotation that requires advice and gets none, an aspect that cannot be instantiated in time, a pointcut that matches nothing (a warning).
5. **Every class Nest manages can be advised.** Providers, controllers, gateways, guards, interceptors, pipes, filters and middleware, in the singleton, request and transient scopes, including classes that reach the container as the instance of a factory or value provider.

### 2.3 Non-goals

- Join points other than method and accessor execution: constructors, field access, call sites, exception handlers.
- Bytecode-style weaving of arbitrary code. Only members of class prototypes are woven; module-level functions, arrow-function class fields and `#private` methods are not join points.
- A string pointcut expression language. Pointcuts are typed values built from combinators (section 6).
- Changing the advice of a running application. The inspector is read-only.
- Advising the objects of an application that does not import `AspectModule`.

---

## 3. How Spring AOP works

This section condenses the Spring Framework reference chapters "Aspect Oriented Programming with Spring" and "Spring AOP APIs". It is the model the rest of the document maps to.

### 3.1 Principles

- AOP complements object-oriented programming; the unit of modularity is the aspect.
- Spring AOP is not a complete AOP implementation. It integrates AOP with the IoC container to solve common enterprise problems, and supports method execution join points on container beans only.
- Business code does not depend on framework types unless it opts in.
- Use the least powerful advice that works: an after-returning advice that fills a cache cannot forget to call `proceed()`, an around advice can.
- Advice declares the parameters it needs with their types instead of handling an `Object[]`.
- Pointcuts are independent of the object-oriented hierarchy. This distinguishes AOP from plain interception.

### 3.2 Programming models

Spring offers four ways to declare aspects. All of them produce the same run-time artifact: a proxy that holds an ordered list of advisors.

| Model                    | Declaration                                                                                                                                                              | Properties                                                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| @AspectJ annotations     | A class with `@Aspect`, `@Pointcut`, `@Before`, `@AfterReturning`, `@AfterThrowing`, `@After`, `@Around`, `@DeclareParents`; enabled by `@EnableAspectJAutoProxy`.       | The recommended model. Supports every instantiation model and the composition of named pointcuts.                                                |
| Schema (XML)             | `<aop:config>`, `<aop:aspect>`, `<aop:pointcut>`, `<aop:before>`, `<aop:advisor>`, `<aop:declare-parents>` over plain objects.                                           | Singleton aspects only; named pointcuts cannot be composed; the knowledge of a concern is split between a class and the configuration.           |
| Low-level Spring AOP API | `Pointcut` (`ClassFilter` and `MethodMatcher`), `Advice` (`MethodInterceptor`, `MethodBeforeAdvice`, `AfterReturningAdvice`, `ThrowsAdvice`), `Advisor`, `ProxyFactory`. | The layer the infrastructure is built on: transactions, caching, method security and asynchronous execution are advisors, not `@Aspect` classes. |
| Full AspectJ             | The AspectJ compiler or load-time weaving.                                                                                                                               | Bytecode weaving without proxies, with every kind of join point. Outside Spring AOP proper.                                                      |

### 3.3 Proxy-based run-time weaving

1. `@EnableAspectJAutoProxy` registers an auto-proxy creator, which is a `BeanPostProcessor`: the container calls it for every bean after the bean is initialized.
2. The creator finds every bean whose class carries `@Aspect` and converts each advice method into one advisor: a pointcut (the parsed AspectJ expression) and an advice object for the advice kind. Advisor beans declared through the low-level API join the same list.
3. For every other bean, the creator selects the advisors whose pointcut can match a method of the bean class, sorts them, and creates a proxy that holds them. A bean no advisor applies to gets no proxy.
4. The proxy is a JDK dynamic proxy when the target implements an interface and a generated subclass (CGLIB) otherwise. It is a different object from the target. The container hands the proxy to every dependent, so a caller can never obtain an unadvised bean.
5. Aspects are excluded from auto-proxying: an aspect is never advised by another aspect.
6. The proxy is created after initialization, so calls a bean makes in its own initialization callbacks do not pass through it.

Consequences of the proxy model that Spring documents as caveats:

- **Self-invocation is not advised.** A call that arrives through a reference passes through the proxy; a call a method makes on `this` goes to the target directly. Spring recommends refactoring, self-injection or, as a last resort, `AopContext.currentProxy()`.
- **Proxy and target have different identities.** `this` (the proxy) and `target` are different objects, which is why AspectJ has two designators for them.
- **Only overridable methods can be advised.** `final` classes and `final` or `private` methods are out of reach of a subclass proxy; a JDK proxy intercepts interface methods only.

### 3.4 The advisor chain

For a call on a proxy, Spring asks the proxy configuration for the interceptor chain of the method and caches the answer per method:

- An advisor whose pointcut matches the method statically contributes its interceptor.
- An advisor whose method matcher is dynamic contributes an interceptor paired with that matcher, which is evaluated with the arguments of every call; when it rejects the call, the interceptor is skipped.

`ReflectiveMethodInvocation.proceed()` walks the chain by index: each call runs the next interceptor, and past the last one it invokes the target method. An interceptor decides whether, when and how often the rest of the chain runs. The `ProceedingJoinPoint` of around advice proceeds through a clone of the invocation, so `proceed()` can be called several times, and each call runs the rest of the chain again.

### 3.5 The pointcut API

```java
public interface Pointcut {
    ClassFilter getClassFilter();
    MethodMatcher getMethodMatcher();
}
public interface ClassFilter { boolean matches(Class<?> clazz); }
public interface MethodMatcher {
    boolean matches(Method m, Class<?> targetClass);                 // static
    boolean isRuntime();
    boolean matches(Method m, Class<?> targetClass, Object... args); // dynamic
}
```

- The class part and the method part are separate so that each can be reused and composed, and so that a class filter can rule out a whole class before any method is examined.
- **Static matching** (`isRuntime()` is false) is evaluated once per method and class and cached.
- **Dynamic matching**: the two-argument `matches` runs first; when it returns true and `isRuntime()` holds, the three-argument form runs with the actual arguments on every call.
- Pointcuts compose by union and intersection.
- Spring ships regular expression pointcuts over method names, attribute-driven pointcuts and a control flow pointcut, and base classes for custom static and dynamic pointcuts.

The default pointcut language is the AspectJ expression language. Spring AOP supports these designators:

| Designator            | Matches                                                                          | Matching |
| --------------------- | -------------------------------------------------------------------------------- | -------- |
| `execution(...)`      | Method executions by modifier, return type, declaring type, name and parameters. | Static   |
| `within(TypePattern)` | Methods declared in the matching types or packages.                              | Static   |
| `this(Type)`          | The proxy is an instance of the type.                                            | Static   |
| `target(Type)`        | The target is an instance of the type.                                           | Static   |
| `args(Types...)`      | The run-time arguments are instances of the types.                               | Dynamic  |
| `@annotation(Ann)`    | The executing method carries the annotation.                                     | Static   |
| `@within(Ann)`        | The declaring type carries the annotation.                                       | Static   |
| `@target(Ann)`        | The class of the target carries the annotation.                                  | Static   |
| `@args(Ann...)`       | The run-time types of the arguments carry the annotations.                       | Dynamic  |
| `bean(nameOrPattern)` | Spring only: the bean name, with `*` wildcards.                                  | Static   |

Expressions are combined with `&&`, `||` and `!`. A `@Pointcut` method gives an expression a name; other expressions refer to it by that name, and Spring recommends building complex pointcuts from small named ones kept in a shared class. The contextual designators (`this`, `target`, `args`, `@annotation` and the other annotation designators) also _bind_: they pass the matched object, argument or annotation to a parameter of the advice method. Spring recommends that a pointcut combine a scoping designator such as `within`, which is cheap and rules out whole groups of classes, with the more specific ones.

### 3.6 The five advice kinds

| Advice            | Runs                              | Can prevent the join point      | Sees the result | Can replace the result | Sees the error |
| ----------------- | --------------------------------- | ------------------------------- | --------------- | ---------------------- | -------------- |
| `@Before`         | Before the join point.            | Only by throwing.               | No              | No                     | No             |
| `@AfterReturning` | After a normal return.            | -                               | Yes             | No                     | No             |
| `@AfterThrowing`  | After the join point throws.      | -                               | No              | -                      | Yes            |
| `@After`          | After the join point in any case. | -                               | No              | No                     | No             |
| `@Around`         | Around the join point.            | Yes, by not calling `proceed()` | Yes             | Yes                    | Yes            |

Exact rules:

- **Before**: an exception thrown by the advice prevents the join point and propagates to the caller.
- **After returning**: receives the returned value and cannot return a different one. An exception thrown by the advice propagates instead of the result. A `returning` parameter type also restricts matching to methods that return that type.
- **After throwing**: receives the exception the join point threw, and that exception propagates after the advice. A `throwing` parameter type restricts the advice to exceptions of that type. The advice sees exceptions of the join point only, not those thrown by the after or after-returning advice of the same aspect. An exception thrown by the advice replaces the original.
- **After** (finally): runs however the join point exits, like a `finally` block; it is meant for releasing resources.
- **Around**: decides whether, when and how often the join point runs, and its return value becomes the result of the call. `proceed()` may be called zero times, once or several times; `proceed(Object[])` runs the rest of the chain with other arguments.

Every advice method can take a `JoinPoint` as its first parameter (`ProceedingJoinPoint` for around advice): `getArgs()`, `getThis()`, `getTarget()`, `getSignature()` and `toString()`.

### 3.7 Ordering

- **Between aspects**: `@Order` or `Ordered.getOrder()` on the aspect class sets the precedence, and a lower value means a higher precedence. Without an order, the order between two aspects is undefined.
- **Nesting**: on the way into a join point, the advice of highest precedence runs first; on the way out, it runs last.
- **Within one aspect**: the advice kinds have a fixed precedence, from highest to lowest: `@Around`, `@Before`, `@After`, `@AfterReturning`, `@AfterThrowing`. The chain from the outside in is therefore `Around -> Before -> After -> AfterReturning -> AfterThrowing -> join point`. This is why after advice runs after the after-returning and after-throwing advice of the same aspect, and why after-throwing advice sees only the exceptions of the join point.
- **Two advice methods of the same kind in one aspect**: the order is undefined, because reflection does not preserve declaration order.
- Advisors of the low-level API are ordered through `Ordered` as well.

### 3.8 Introductions

`@DeclareParents(value = "com.xyz.service.*+", defaultImpl = DefaultUsageTracked.class) public static UsageTracked mixin;` declares that the beans the type pattern matches implement `UsageTracked`, with `DefaultUsageTracked` as the implementation. The type of the field names the interface. Advice can bind the introduced view (`this(usageTracked)`), and callers can obtain the bean as the introduced type.

- An introduction applies to whole classes: its advisor has a class filter and no method matcher.
- An introduction is stateful, so each advised object gets its own delegate.
- An introduced interface hides the target's own implementation of that interface.
- Introductions cannot be added to or removed from an existing proxy.

### 3.9 Aspect instantiation models

| Model                        | Meaning                                                           |
| ---------------------------- | ----------------------------------------------------------------- |
| singleton (default)          | One aspect instance per container.                                |
| `perthis(pointcut)`          | One aspect instance per proxy object at the matched join points.  |
| `pertarget(pointcut)`        | One aspect instance per target object at the matched join points. |
| `pertypewithin(TypePattern)` | One aspect instance per matched type.                             |

A per-object aspect instance is created at the first matched call on that object and lives as long as the object. AspectJ's `percflow` models are not supported.

### 3.10 The low-level API and its extension points

- `MethodInterceptor` (AOP Alliance): `Object invoke(MethodInvocation invocation)`, where `invocation.proceed()` continues the chain. It is the fundamental advice type.
- `MethodBeforeAdvice`, `AfterReturningAdvice` and `ThrowsAdvice` are narrower advice types.
- `Advisor` holds one advice and one pointcut. `DefaultAdvisorAutoProxyCreator` applies every advisor bean in the context to every bean its pointcut matches.
- `AdvisorAdapterRegistry` converts an advice object of any type into a `MethodInterceptor`; registering an adapter adds an advice type.
- `ReactiveAdapterRegistry` lets infrastructure interceptors (transactions, caching) follow reactive return types. General @AspectJ advice does not use it: it sees a `CompletableFuture` or a `Mono` as an ordinary return value, so after-returning advice receives the future and after-throwing advice does not run for an asynchronous failure.
- `ProxyFactory` and `AspectJProxyFactory` create proxies programmatically. Every proxy implements `Advised`, through which the advisors can be listed and, unless the proxy is frozen, changed. A `TargetSource` supplies the target of a proxy per call (hot swapping, pooling).

---

## 4. What nestjs-aspect adopts from Spring

### 4.1 Concept mapping

| Spring                                                              | nestjs-aspect                                                                         | Notes                                                                                                                   |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `@EnableAspectJAutoProxy`                                           | `AspectModule.forRoot(options)` / `AspectModule.forRootAsync(...)`                    | A global module, imported once.                                                                                         |
| `@Aspect` with `@Component`                                         | `@Aspect({ order?, instantiation? })`, listed in the `providers` of a module          | `@Aspect()` implies `@Injectable()`. Nest has no component scanning; the `providers` entry corresponds to `@Component`. |
| Auto-proxy creator                                                  | The weaver of `AspectModule`                                                          | It detects aspect and advisor classes in the container and advises every class their pointcuts match.                   |
| `@Pointcut` method                                                  | A constant: `export const inServiceLayer = P.inModule(ServiceModule)`                 | Referenced as a value instead of by a name in a string.                                                                 |
| AspectJ pointcut expression                                         | The `P` designators with `.and()`, `.or()`, `.not()`, `P.all()`, `P.any()`            | Section 4.2.                                                                                                            |
| `@Before`, `@AfterReturning`, `@AfterThrowing`, `@After`, `@Around` | The same names                                                                        | The same semantics, applied to the settled result of an asynchronous join point (section 4.3).                          |
| `returning = "value"`                                               | Second parameter of `@AfterReturning` advice                                          | Typed from the pointcut.                                                                                                |
| `throwing = "ex"` with an exception type                            | `@AfterThrowing(pointcut, { throwing: ErrorClass })` and the second parameter         | The advice runs for errors that are `instanceof` the class.                                                             |
| `JoinPoint`, `ProceedingJoinPoint`                                  | `JoinPoint<S>`, `ProceedingJoinPoint<S>`; aliases `JP<typeof pointcut>`, `PJP<...>`   | `proceed()` and `proceedWith(...args)`.                                                                                 |
| `args(account, ..)` binding                                         | `P.args(Account, P.REST)` types `jp.args` as `[Account, ...unknown[]]`                | The arguments are read from the join point; there is no binding by parameter name.                                      |
| `@annotation(retryable)` binding                                    | `P.annotated(Retryable)` makes `jp.annotation(Retryable)` callable and typed          | The compiler accepts the call only when the pointcut guarantees the annotation.                                         |
| Java annotation                                                     | `createAnnotation(name, options?)`, or a Nest `Reflector.createDecorator()` decorator | A typed value and an optional method contract.                                                                          |
| `@Order`, `Ordered`                                                 | `@Aspect({ order })`, the `order` property of an `@Advisor` instance                  | Lower runs first.                                                                                                       |
| `perthis`, `pertarget`                                              | `instantiation: "perTarget"`                                                          | One model: there is no proxy object.                                                                                    |
| `pertypewithin`                                                     | `instantiation: "perClass"`                                                           |                                                                                                                         |
| `@DeclareParents`                                                   | `@DeclareParents(target, { use })` on a static member; `isIntroduced`, `introduced`   | Section 4.7.                                                                                                            |
| `this(usageTracked)` binding of an introduction                     | `jp.introduced(UsageTracked)`                                                         |                                                                                                                         |
| `Advisor` bean                                                      | A class decorated with `@Advisor()`                                                   | Section 4.5.                                                                                                            |
| `MethodInterceptor`, `MethodInvocation`                             | `MethodInterceptor`, `MethodInvocation`                                               | `invocation.proceed()`, `invocation.cloneFromHere(args?)`.                                                              |
| `Pointcut`, `ClassFilter`, `MethodMatcher`                          | `PointcutLike`, `ClassFilter`, `MethodMatcher`                                        | `matches`, `isRuntime`, `matchesRuntime`.                                                                               |
| `AdvisorAdapterRegistry`                                            | `AdviceAdapter` and the `adviceAdapters` option                                       | Section 4.6.                                                                                                            |
| `ReactiveAdapterRegistry`                                           | `ReturnValueAdapter` and the `returnValueAdapters` option                             | Used by every advice kind, not by infrastructure only.                                                                  |
| `Advised` (inspection)                                              | `AspectInspector` and the weaving report                                              | Read-only.                                                                                                              |
| `AopContext.currentProxy()`                                         | Not needed                                                                            | Self-invocation is advised.                                                                                             |
| `bean(name*)`                                                       | `P.bean("token*" \| /pattern/ \| Class)`                                              | Matches provider tokens.                                                                                                |
| Package                                                             | Nest module: `P.inModule(Module, { transitive })`                                     |                                                                                                                         |

### 4.2 Pointcut designators

| `P.`                                         | Spring equivalent                       | Matching          | Types it gives the advice                                                    |
| -------------------------------------------- | --------------------------------------- | ----------------- | ---------------------------------------------------------------------------- |
| `method(Type, "name")`                       | `execution(* Type+.name(..))`           | Static            | The exact target, argument and return types of that method.                  |
| `within(...Types)`                           | `within(Type)`                          | Static            | The target type.                                                             |
| `target(Type)`                               | `target(Type)` and `this(Type)`         | Static            | The target type.                                                             |
| `name("find*" \| /^find/)`                   | The name pattern of `execution`         | Static            | -                                                                            |
| `kind("method" \| "getter" \| "setter")`     | - (AspectJ `get` and `set` join points) | Static            | -                                                                            |
| `annotated(A)`                               | `@annotation(A)`                        | Static            | The argument and return types of the method contract of `A`; guarantees `A`. |
| `withinAnnotated(A)`                         | `@within(A)`                            | Static            | Guarantees `A`.                                                              |
| `targetAnnotated(A)`                         | `@target(A)`                            | Static            | Guarantees `A`.                                                              |
| `args(A, P.ANY, P.REST)`                     | `args(A, *, ..)`                        | Dynamic           | The argument tuple.                                                          |
| `bean(token)`                                | `bean(name)`                            | Static            | -                                                                            |
| `inModule(Module, { transitive })`           | `within(package..*)`                    | Static            | -                                                                            |
| `metadata(key, predicate?)`                  | An attribute-driven pointcut            | Static            | -                                                                            |
| `matching({ classFilter?, methodMatcher? })` | A custom `Pointcut`                     | Static or dynamic | -                                                                            |

Rules of the designators:

- `method` matches when the class is `Type` or a subclass and the member is the method `name`. It is the only designator that selects a Nest lifecycle hook.
- `within` matches members whose declaring class is one of the given classes. An inherited member belongs to the class that declares it.
- `target` matches every member of `Type` and its subclasses.
- `name` tests the whole member name; in a string, `*` matches any run of characters. Symbol-named members never match.
- `kind("getter")` and `kind("setter")` are the only designators that select accessors.
- `annotated` matches a member that itself carries the annotation. Method annotations are not inherited by an override.
- `withinAnnotated` matches members whose declaring class carries the annotation; `targetAnnotated` matches members of a class that carries it. Class annotations are inherited by subclasses.
- `args` is evaluated on every call. A class matches an argument that is `instanceof` it; `String`, `Number`, `Boolean`, `BigInt` and `Symbol` match their primitives; `P.ANY` matches one argument of any value; `P.REST`, valid in last position only, matches the remaining arguments. Without `P.REST` the argument count must equal the matcher count.
- `bean` matches a class of which one registration has a matching provider token. A string is compared with a string token or with the name of a class token or the description of a symbol token; `*` is a wildcard. A regular expression tests the same text, and a class matches the identical token.
- `inModule` matches the providers and controllers a module declares; with `transitive`, also those of the modules it imports, at any depth. Nest adds every global module to the imports of every module, so an edge to a global module counts only when the `@Module()` metadata of the importing module lists it.
- `metadata` matches a member on which Reflect metadata `key` is defined, on the member function (as `SetMetadata` stores it) or on the prototype and member name. It connects pointcuts to the decorators of other libraries.
- `matching` wraps a hand-written class filter and method matcher, which may be dynamic.

Composition follows Spring: `a.and(b)` is the intersection, `a.or(b)` the union and `a.not()` the complement. `P.all(...)` and `P.any(...)` fold a list. Named pointcuts are constants, and a shared file of constants plays the role of Spring's shared pointcut class:

```ts
export const inServiceLayer = P.inModule(ServiceModule, { transitive: true });
export const idempotent = P.annotated(Idempotent);
export const idempotentServiceCall = inServiceLayer.and(idempotent);
```

Static and dynamic matching work as in section 3.5. Every pointcut is a `{ classFilter, methodMatcher }` pair. The static part is evaluated once per class and member when the class is woven; only advisors whose static part matches are attached to the member. A dynamic method matcher (`isRuntime`) is evaluated with the arguments on every call, and when it rejects the call its interceptor is skipped. For a composite, the static `matches` answers "may match": `or()` and `not()` evaluate each operand completely at run time, `and()` evaluates the dynamic parts only. As in Spring, a dynamic designator is combined with a static one that scopes it.

### 4.3 Advice semantics

| Decorator                              | Advice signature                               | Semantics                                                                                                                                                                       |
| -------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@Before(pc)`                          | `(jp: JoinPoint<S>) => R`                      | Runs before the join point. An error prevents the join point and propagates.                                                                                                    |
| `@AfterReturning(pc)`                  | `(jp: JoinPoint<S>, result) => R`              | Runs after a normal completion with the result. It cannot replace the result. An error it throws propagates instead of the result.                                              |
| `@AfterThrowing(pc, { throwing?: E })` | `(jp: JoinPoint<S>, error: E) => R`            | Runs when the join point fails, with `throwing` only for errors that are `instanceof` that class. The same error propagates afterwards; an error the advice throws replaces it. |
| `@After(pc)`                           | `(jp: JoinPoint<S>) => R`                      | Runs after the join point whatever its outcome. An error it throws replaces the outcome.                                                                                        |
| `@Around(pc)`                          | `(jp: ProceedingJoinPoint<S>) => S["returns"]` | Surrounds the join point. Its return value becomes the result of the call. `proceed()` can be called zero times, once or several times.                                         |

`S` is the shape of the pointcut. `R` is `void`, or `void | PromiseLike<void>` when the join point is or may be asynchronous. The result parameter of after-returning advice has the awaited return type of the join point.

These are the Spring semantics of section 3.6. The one extension is the meaning of "completion" for an asynchronous join point: the result is the value a promise resolves to, and a failure is its rejection (section 7.3).

The join point API corresponds to Spring's: `jp.target` (`getTarget()` and `getThis()`), `jp.args` (`getArgs()`), `jp.signature` with `name`, `declaringType` and `targetType` (`getSignature()`), `jp.kind`, `jp.isAsync`, `jp.toString()`, and `proceed()` and `proceedWith(...args)` on the proceeding join point (`proceed()` and `proceed(Object[])`).

### 4.4 Ordering

- Across aspects and advisors a lower `order` has the higher precedence: its advice runs first on the way in and last on the way out. An aspect or advisor without an order has the lowest precedence.
- Within one aspect the advice kinds are ordered `Around -> Before -> After -> AfterReturning -> AfterThrowing -> join point`, as in Spring since 5.2.7. After advice therefore runs after the after-returning and after-throwing advice of its aspect, and after-throwing advice sees the errors of the join point only.

Section 6 describes the two places where Spring leaves the order undefined and this library defines it.

### 4.5 The Advisor, MethodInterceptor and Pointcut layer

The low-level layer is the one aspects compile to, and it is public for library authors, as in Spring.

```ts
interface PointcutLike {
  readonly classFilter: ClassFilter;
  readonly methodMatcher: MethodMatcher;
}
interface ClassFilter {
  matches(type: ClassRef): boolean;
}
interface MethodMatcher {
  matches(method: MethodRef): boolean;
  readonly isRuntime: boolean;
  matchesRuntime?(method: MethodRef, args: readonly unknown[]): boolean;
}
interface MethodInterceptor {
  invoke(invocation: MethodInvocation): unknown;
}
interface MethodInvocation {
  readonly method: MethodRef;
  readonly target: object;
  readonly args: readonly unknown[];
  readonly joinPoint: JoinPoint<AnyShape>;
  proceed(): unknown;
  cloneFromHere(args?: readonly unknown[]): MethodInvocation;
}
interface PointcutAdvisor {
  pointcut: PointcutLike;
  advice: Advice;
  order?: number;
}
```

`ClassRef` describes a class as the container registers it: `type`, the `beans` (provider token and declaring module of each registration) and `reachesModule(root, imported)`. `MethodRef` describes a member: `declaringType`, `targetType`, `classRef`, `name`, `kind`, the `original` function and `isAsync`.

An advisor is a provider class decorated with `@Advisor()`:

```ts
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

The weaver detects advisor classes like aspects and applies each to every member its pointcut matches, which is the behavior of Spring's `DefaultAdvisorAutoProxyCreator`. An aspect and an advisor are ordered in one list. `invocation.proceed()` advances the invocation, so an interceptor that runs the rest of the chain more than once proceeds through `invocation.cloneFromHere()`, as Spring's proceeding join point does.

### 4.6 Adapter interfaces

- **`AdviceAdapter`** corresponds to an adapter of Spring's `AdvisorAdapterRegistry`: `supports(advice)` and `toInterceptor(advice, context)`. The `adviceAdapters` option of `AspectModule` registers adapters, which are consulted in the given order before the two built-in ones: the adapter for advice compiled from an aspect and the adapter that passes a `MethodInterceptor` through. An adapter adds an advice kind: the `advice` of an `@Advisor` can then be an object of that kind. `context.returnValues` gives the adapter the return value adapters of the application.
- **`ReturnValueAdapter`** corresponds to an adapter of Spring's `ReactiveAdapterRegistry`: `supports(value)`, `onSuccess(value, callback)`, `onError(value, callback)` and `finally(value, callback)`. The `returnValueAdapters` option registers adapters, consulted in the given order before the built-in `promiseAdapter`. The `nestjs-aspect/rxjs` entry exports `observableAdapter`.

### 4.7 Instantiation models and introductions

**Instantiation models.** `@Aspect({ instantiation })` accepts `"singleton"` (the default), `"perTarget"` and `"perClass"`. As in Spring, an instance of a per-target aspect is created at the first advised call on a target object and lives as long as that object, and a per-class aspect has one instance per advised class.

**Introductions.** `@DeclareParents` keeps the Spring form: a static member of an aspect whose type names the introduced interface, a filter that selects the classes, and the implementation class.

```ts
export abstract class UsageTracked {
  abstract incrementUseCount(): void;

  abstract get useCount(): number;
}

@Aspect()
export class UsageTrackingAspect {
  @DeclareParents(P.inModule(ServiceModule), { use: DefaultUsageTracked })
  static readonly mixin: UsageTracked;

  @Before(P.inModule(ServiceModule))
  record(jp: JoinPoint<AnyShape>): void {
    jp.introduced(UsageTracked).incrementUseCount();
  }
}
```

- An introduction applies to whole classes: of a pointcut passed as the target, only the class filter is used.
- Each target object has its own delegate, created on first use.
- The methods and accessors of the implementation class become members of every matched class and run on the delegate of the object they are called on.
- `jp.introduced(Token)` corresponds to binding the introduced view in advice; `isIntroduced(object, Token)` and `introduced(object, Token)` correspond to obtaining the bean as the introduced type.

---

## 5. Platform constraints and the weaving strategy

### 5.1 Constraints of TypeScript, Node.js and Nest

| #   | Constraint                                                                                                                                                                              | Consequence                                                                                                                                                                       |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | Types do not exist at run time. `design:paramtypes` and `design:returntype` metadata exists only for members that carry a decorator, and only with `emitDecoratorMetadata`.             | A pointcut cannot match by return type or parameter type, as `execution(String *(..))` does. Type information lives in TypeScript types, so a pointcut carries it statically.     |
| C2  | Nest uses legacy decorators (`experimentalDecorators`); its parameter decorators require them.                                                                                          | The API consists of legacy class, method and property decorators. `TypedPropertyDescriptor<T>` lets a decorator constrain the type of the method it decorates.                    |
| C3  | There are no packages.                                                                                                                                                                  | The unit that groups classes in Nest is the module: `within(com.xyz.service..*)` corresponds to `P.inModule(ServiceModule, { transitive: true })`.                                |
| C4  | Asynchronous results are the norm: promises everywhere, Observables in controllers and RxJS code.                                                                                       | Advice must follow the settlement of a result. Advice that sees only the synchronous return makes after-returning and after-throwing advice meaningless for asynchronous methods. |
| C5  | Nest has no bean post-processor: no extension point lets a library replace an instance between its creation and its injection into dependents.                                          | A proxy cannot be substituted for a provider without changing Nest internals. Weaving happens on the class prototype, and its time must be chosen (section 5.3).                  |
| C6  | When an application initializes, Nest registers the routes before it runs the `onModuleInit` hooks, and the router binds the function that the controller prototype holds at that time. | A member replaced in an `onModuleInit` hook is too late for route handlers.                                                                                                       |
| C7  | Nest runs `onModuleInit` module by module: global modules first, then the others from the deepest import level upwards.                                                                 | Weaving in the `onModuleInit` hook of an ordinary module leaves the hooks that run earlier, and everything they call, unadvised.                                                  |
| C8  | Several Nest applications can live in one process, as in a test suite, and class prototypes are shared by all of them.                                                                  | The advice of a class cannot be a property of its prototype. Each application has its own advice, and a call must find the application its object belongs to.                     |
| C9  | An arrow-function class field is an own property of each instance, and a `#private` method is not reachable from outside the class.                                                     | Neither is a join point. This is the counterpart of Spring's `final` and `private` restriction.                                                                                   |
| C10 | `Reflect.getMetadata` follows the prototype chain of the object it is given.                                                                                                            | A replacement function whose prototype is the original function exposes all metadata defined on the original, such as route and `SetMetadata` metadata, without copying it.       |

### 5.2 The strategy: in-place prototype weaving during provider instantiation

Three mechanisms can connect advice to a Nest class:

|                                                | In-place prototype weaving during instantiation (chosen)            | Proxy substitution in the container                                                  | Decorator-installed stubs on annotated methods      |
| ---------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------- |
| Pointcuts that need no decorator on the target | Yes                                                                 | Yes                                                                                  | No: every target method needs a decorator           |
| Controllers and gateways (C6)                  | Yes: woven before the routes are registered                         | No: the router calls the prototype function on the original instance                 | Yes                                                 |
| Order relative to lifecycle hooks (C7)         | Woven before every lifecycle hook                                   | Depends on the point of substitution                                                 | Depends on when the aspects are connected           |
| Self-invocation                                | Advised                                                             | Not advised                                                                          | Advised                                             |
| Identity, `instanceof`, `this`                 | Unchanged: the caller holds the target                              | The proxy and the target are different objects                                       | Unchanged                                           |
| Feasibility in Nest (C5)                       | Uses `ModulesContainer`, a public provider, in one factory provider | Requires replacing instances before injection, for which Nest has no extension point | Feasible, but cannot express non-invasive pointcuts |

`nestjs-aspect` replaces each matched member on the class prototype with a _dispatcher stub_. The stub finds the application the called object belongs to and runs that application's interceptor chain for the member. The weaving happens while the container instantiates its providers, in a factory provider of the global `AspectModule`: the module scan is complete at that point, so every class is known, and no route or lifecycle hook has captured a function yet.

### 5.3 The weaving pipeline

```
NestFactory.create() / Test.createTestingModule().compile()
 |- module scan: modules, providers, controllers and their classes are final
 |- provider instantiation
 |   |- weaver factory of AspectModule                              <- stage 1
 |   |    1. scan the container for aspect and advisor classes and for candidates
 |   |    2. compile each aspect into advisors; an @Advisor class contributes
 |   |       its static pointcut
 |   |    3. for each candidate class, superclasses first, and each member:
 |   |       match the advisors statically; install a stub for a matched member
 |   |    4. apply the introductions; install stubs that reject the members
 |   |       whose required advice nothing supplies
 |   '- the other providers are instantiated
 |- application init: routes are registered (the router binds the stubs),
 |  then the lifecycle hooks run (already advised)
 |   '- AspectModule.onModuleInit                                   <- stage 2
 |        - weave the classes known only now: middleware, and the classes of
 |          the instances of singleton factory and value providers
 |        - validate the configuration; log the weaving report
 '- shutdown: AspectModule.onApplicationShutdown closes the weaving context
```

**Stage 1** needs no instance. Aspects compile from class metadata, and an `@Advisor` class exposes its pointcut as a static member. The candidates are the classes of the provider, controller, enhancer and middleware collections of every module. Not woven are: aspect and advisor classes, module classes, the classes of Nest itself (a class that extends one is woven), the two providers of the weaver, classes of the `exclude` option, native classes and plain objects. A call that reaches a stub before the instance of an aspect or advisor that advises it exists raises `AspectNotReadyError`; the instance is read from the container once Nest has constructed it.

Because stage 1 runs inside the provider instantiation, it has also run when `Test.createTestingModule(...).compile()` returns: advice works in a test without `init()`.

**Stage 2** scans the container again, now with instances. A singleton factory or value provider contributes the class of its instance, and a class whose registrations changed is matched again with all its provider tokens, so `P.bean("TOKEN")` selects the instance of a factory provider. Nest fills the middleware collection of a module after the instantiation, so a middleware class that is not also a provider is woven in stage 2, after the router has bound its `use` method. The instance of a request-scoped or transient factory provider has no singleton to examine: its class is woven when the container first resolves such an instance. Stage 2 then validates the configuration (section 7.6) and logs the weaving report.

**Shutdown** closes the weaving context. Stubs are never removed; a stub whose object belongs to no live application runs the original function.

The following properties of NestJS make the pipeline correct. The tests of this package assert each of them through the behavior they cause, so a change in Nest that breaks one fails the suite:

- **A factory provider runs after the module scan and during provider instantiation.** The weaver sees every class and has run when `compile()` returns (`weaves during compile(), without init()`).
- **Routes are registered before the lifecycle hooks, and the router binds the prototype function it finds.** A route handler is advised only because the stub is in place before the registration (`weaves before the router and the lifecycle hooks, and stops advising after close`).
- **`onModuleInit` runs for global modules first.** A hook of the deepest ordinary module already finds its dependencies advised (same test).
- **The `onModuleInit` hooks of global modules run in import order and their `onApplicationShutdown` hooks in reverse order.** With `AspectModule` imported first, stage 2 precedes the hooks of every other module and the context closes after theirs (`advises the shutdown hook of a global module`). Stage 2 warns about a global module with a shutdown hook that is imported before `AspectModule`.
- **The stub is a function on the prototype, so instances of every scope share it.** Request-scoped and transient instances created after the weaving are advised.

`forRootAsync` keeps the pipeline: the weaver factory injects the options, so Nest resolves them first, still inside the provider instantiation. The options come from singleton providers; options that depend on a request-scoped or transient provider make Nest skip the weaver factory, which a provider without dependencies of its own reports as an `AspectConfigurationError` in `onModuleInit`.

### 5.4 The dispatcher stub

```ts
function createStub(owner, name, kind, original) {
  const stub = function (this: unknown, ...args: unknown[]) {
    const context = resolveContext(this, owner);
    return context
      ? context.dispatch(owner, name, kind, this, args, original)
      : original.apply(this, args);
  };
  // The stub keeps the name and the length of the original function.
  Object.setPrototypeOf(stub, original); // C10
  registerStub(stub, { owner, original });
  return stub;
}
```

- A class has one stub per member and kind, whatever the number of advisors and applications. A class no advisor matches is not touched.
- The stub has the original function as its prototype, so route metadata, `SetMetadata` values and the metadata of other libraries remain visible on it.
- A function is a stub because the process-wide registry records it, never because of a property it carries. The registry is an own, non-writable, non-configurable property of `globalThis` under a `Symbol.for` key, so the stubs and applications of two copies of the package, such as the CommonJS build next to the ES module build, work together.
- **Inherited members.** The stub of an inherited member is installed on the concrete class and calls the inherited original function. A subclass that matches no advisor for a member has no stub of its own and reaches the stub of a woven superclass by inheritance: the application then runs the original function when it examined the subclass, so a pointcut that leaves the subclass out holds. A `super` call from an override is an execution of the superclass member and is advised when the superclass is woven. An instance of a class of the `exclude` option runs the original function in every stub it reaches.
- **Accessors.** A getter and a setter of one property are replaced independently.
- **Default join points.** Broad pointcuts match methods only, without the Nest lifecycle hooks (`onModuleInit`, `onApplicationBootstrap`, `onModuleDestroy`, `beforeApplicationShutdown`, `onApplicationShutdown`). `P.method` selects a lifecycle hook, and `P.kind` selects accessors. `constructor` is never a join point.

### 5.5 The per-application weaving context

Each application has one `WeavingContext`: its woven members, their advisors and their cached interceptor chains. A stub resolves the context of the object it is called on in this order:

1. **Ownership.** An object belongs to the live contexts that own it. A context owns the instances its container creates or hands out, which the weaver observes for every provider of the container: this covers request-scoped, transient and durable instances and the instances of scoped factory providers. It also owns the static instances its container holds. A single owner takes the object whether or not it advises the member: an application that excludes the class, or matches nothing in it, runs the original function for its own instances even while another application advises the class.
2. **Several owners.** For one object that the containers of several applications hold, such as a shared `useValue` object, the owner that advises the class takes it. When several owners advise it, rule 5 decides.
3. **Closed owners.** An object whose owners are all closed or garbage collected runs the original function. It is not adopted by another application. Closing a context records the instances its container holds, so this includes an instance that was never called.
4. **No owner.** An object no container created or holds - one created with `new`, one still under construction, a detached call without `this` - goes to the live contexts that advise the class of the stub: none runs the original, one takes the object. Of several, the one context that owns the objects in the properties of the object, such as its injected dependencies, takes it. Otherwise rule 5 decides. Such an object is resolved on every call, so it follows the applications as they start and close.
5. **Ambiguity.** When several live applications advise an object and nothing tells them apart, the call raises `AspectUsageError` if any of them is strict. When all of them set `strict: false`, the most recently created one advises the object and logs a warning once per class.

The registry refers to contexts weakly. An application that is abandoned without `close()`, such as a testing module that is dropped or an application whose bootstrap failed, counts as live until it is garbage collected, and the registry keeps no container alive.

---

## 6. Deliberate differences from Spring

| Topic                                    | Spring AOP                                                      | nestjs-aspect                                                                                   | Reason                                                                                                                                     |
| ---------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Weaving mechanism                        | A proxy object per advised bean                                 | Dispatcher stubs on the class prototype                                                         | C5: Nest cannot substitute an instance before injection, and the router calls prototype functions (C6).                                    |
| Self-invocation                          | Not advised                                                     | Advised                                                                                         | The stub is the member itself, so `this.other()` reaches it. This is the AspectJ behavior and removes Spring's most common caveat.         |
| `this` and `target`                      | Different objects, two designators                              | One object, `P.target`                                                                          | There is no proxy.                                                                                                                         |
| Pointcut language                        | AspectJ expression strings                                      | Typed combinators (`P`)                                                                         | C1: a string cannot carry types to the advice and is not checked by the compiler.                                                          |
| Return and parameter type patterns       | `execution(String *(int, ..))`                                  | Not available; `P.method`, `P.args` and annotation contracts carry types                        | C1.                                                                                                                                        |
| `returning` type restricts matching      | Yes                                                             | No: the result type is checked at compile time                                                  | C1.                                                                                                                                        |
| Packages                                 | `within(package..*)`                                            | `P.inModule(Module, { transitive })`                                                            | C3.                                                                                                                                        |
| Binding by parameter name                | `args(account, ..)`, `@annotation(retryable)`                   | Typed access through the join point: `jp.args`, `jp.annotation(A)`                              | Parameter names are not available at run time; the pointcut type carries the same information.                                             |
| Granularity of `bean()`                  | The bean instance                                               | The class: a class matches when one of its registrations has a matching token                   | Weaving replaces members of the prototype, which every registration of the class shares.                                                   |
| Join point kinds                         | Methods                                                         | Methods, and accessors when `P.kind` selects them                                               | An accessor is a function on the prototype like a method.                                                                                  |
| Lifecycle callbacks                      | Advised like other methods once the proxy exists                | Advised only when `P.method` names the hook                                                     | A broad pointcut that wrapped lifecycle hooks would run advice during bootstrap and shutdown, when aspects may not exist yet or no longer. |
| Asynchronous results                     | General advice sees the future or publisher as the return value | Every advice kind follows the settlement                                                        | C4.                                                                                                                                        |
| Asynchronous advice                      | Not applicable (blocking)                                       | Allowed on asynchronous join points; a compile error or `AspectUsageError` on a synchronous one | A synchronous join point cannot wait for a promise without changing its return type.                                                       |
| Order of aspects without an order        | Undefined                                                       | Registration order, with a warning                                                              | Determinism goal; the container lists providers in a stable order.                                                                         |
| Order of same-kind advice in one aspect  | Undefined                                                       | Declaration order                                                                               | TypeScript applies member decorators in source order.                                                                                      |
| Arguments of the join point              | `getArgs()` returns a copy                                      | `jp.args` is frozen; `proceedWith(...args)` replaces the arguments                              | Same isolation, enforced.                                                                                                                  |
| Pointcut of an advisor                   | `getPointcut()` of the advisor bean                             | The static member `pointcut` of the `@Advisor` class                                            | Stage 1 matches pointcuts before any instance exists, and Nest cannot instantiate chosen providers ahead of the others.                    |
| A call before the aspect instance exists | The container creates the aspect bean on demand                 | `AspectNotReadyError`                                                                           | Nest cannot create a provider on demand during instantiation.                                                                              |
| An aspect supplied by a factory          | A regular aspect (`@Bean` method)                               | Rejected when the application initializes                                                       | A factory provider has no class before its instance exists, so its pointcuts cannot be matched in stage 1.                                 |
| Scope of aspects                         | Singleton, or prototype for the per-object models               | Always a singleton provider                                                                     | Advice is resolved synchronously during a call; Nest resolves scoped providers asynchronously.                                             |
| `perthis` and `pertarget`                | Two models, each with a pointcut argument                       | One model, `"perTarget"`, without a pointcut argument                                           | There is no proxy object, and the instance is created at the first call any advice of the aspect serves.                                   |
| Dependencies of a per-object aspect      | Any bean                                                        | Singleton providers only                                                                        | The instance is created synchronously during a call, with `ModuleRef.get`.                                                                 |
| Interface of an introduction             | A Java interface                                                | An abstract class                                                                               | C1: a TypeScript interface leaves no value at run time. The token is read from the `design:type` metadata of the static member.            |
| Type of an object with an introduction   | The proxy implements the interface                              | The declared type is unchanged; `isIntroduced` narrows it, `introduced` returns the delegate    | TypeScript cannot widen the type of a class from outside it.                                                                               |
| Introduction that collides with a member | The introduction wins                                           | `AspectConfigurationError`, unless the introduction sets `override: true`                       | Determinism goal.                                                                                                                          |
| Delegate of an introduction              | A bean or an instance the advisor holds                         | `new use()`, without injection                                                                  | The delegate is created synchronously for one target on first use.                                                                         |
| Silent non-matches                       | Silent                                                          | `requiresAdvice` annotations, and a warning for a pointcut that matches nothing                 | Determinism goal.                                                                                                                          |
| `Advised` mutation                       | Supported unless frozen                                         | Not supported; `AspectInspector` is read-only                                                   | The stub is shared by every instance of a class, so a change would not be local to one object.                                             |
| Objects created with `new`               | Never advised by Spring AOP                                     | Advised when exactly one live application can be identified for them                            | The stub is on the prototype (section 5.5).                                                                                                |
| Thenables that are not promises          | Not applicable                                                  | Plain values, unless the method is declared asynchronous                                        | Following a lazy thenable, such as a query builder, would execute it.                                                                      |

**The `requiresAdvice` rule.** `createAnnotation(name, { requiresAdvice: true })` states that a member carrying the annotation must be advised by an advisor that handles the annotation. An advisor handles it when its pointcut refers to the annotation with `P.annotated`, `P.withinAnnotated` or `P.targetAnnotated`, in any position of a composition, or when the pointcut contains a caller-supplied matcher (`P.matching`, a hand-written `PointcutLike`), whose annotations cannot be told. A broad pointcut such as `P.within(UserService)` does not stand in for a missing aspect. A class annotation requires advice on the default join points of the class; an accessor or a lifecycle hook only for an annotation it carries itself. A member whose required advice nothing supplies is a validation error, and in every mode its call raises `AspectConfigurationError` instead of running without the advice. The same holds for such a member of a class that is never advised: an aspect, an advisor, a module class or an excluded class.

---

## 7. Runtime semantics

### 7.1 Chain construction

The chain of a member is built on its first call and cached for the lifetime of the application:

1. Take the advisors whose pointcut matched the member statically.
2. Sort them: `order` ascending, with an unspecified order last; then the registration position of the aspect or advisor class in the container; within one aspect the advice kind (around, before, after, after returning, after throwing); then the declaration position.
3. Convert each advice into a `MethodInterceptor` through the advice adapters.
4. Pair the interceptor of an advisor with a dynamic method matcher with that matcher.

An advisor of an `@Advisor` class is described from its instance at this point (`advice` and `order`). A missing instance raises `AspectNotReadyError`, and the chain is built again on the next call. An advice no adapter converts raises `AspectConfigurationError`.

### 7.2 Invocation

A call creates one `Invocation` with the target, a frozen copy of the arguments and an index into the chain. `proceed()` takes the next link; a link whose dynamic matcher rejects the arguments is skipped; past the last link it calls the original function with the target as `this`. This is the algorithm of Spring's `ReflectiveMethodInvocation`.

`ProceedingJoinPoint.proceed()` runs `invocation.cloneFromHere().proceed()`, and `proceedWith(...args)` runs `invocation.cloneFromHere(args).proceed()`. Around advice can therefore proceed any number of times, each time through the rest of the chain and from the arguments the advice received or passes.

The aspect instance is resolved when the chain reaches the advice: the provider instance of a singleton aspect, or the instance that belongs to the target object or class (section 7.4).

### 7.3 Asynchronous join points and return value adapters

A result is _asynchronous_ when a return value adapter supports it. The built-in `promiseAdapter` supports instances of `Promise`. A thenable that is not a `Promise` is followed as `Promise.resolve(value)` only when the method is declared asynchronous: a native `async` function, or a method whose `design:returntype` metadata is `Promise`. Returned from any other method it is a plain value and reaches the caller untouched.

| Kind            | Interceptor                                                                                                                                                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Before          | Runs the advice, then proceeds. Advice that returns a thenable is awaited before proceeding when the method is declared asynchronous; on any other method it raises `AspectUsageError`.                                      |
| After returning | Proceeds. For an asynchronous result, `adapter.onSuccess(result, value => advice(jp, value))`: the advice runs with the settled value, is awaited, and the value is kept. For a synchronous result, the advice runs with it. |
| After throwing  | Proceeds. A synchronous throw runs the advice and rethrows. For an asynchronous result, `adapter.onError(result, ...)`: the advice runs with the error and is awaited, then the same error propagates.                       |
| After           | Proceeds. A synchronous throw runs the advice and rethrows; an asynchronous result uses `adapter.finally(result, ...)`; a synchronous result runs the advice and is returned.                                                |
| Around          | Calls the advice with the proceeding join point and returns what it returns. Around advice sees the promise itself and awaits it when it needs the settled result.                                                           |

- Advice that returns a promise is awaited on an asynchronous join point, and the settlement the caller sees waits for it. On a synchronous join point such advice raises `AspectUsageError`; the advice decorators reject it at compile time when the pointcut type shows that the join point is synchronous.
- On a method declared asynchronous, an error that before advice throws synchronously is delivered as a rejection, as the method itself would deliver it.
- Because the chain order is `Around -> Before -> After -> AfterReturning -> AfterThrowing -> join point`, after-throwing advice sees only the errors of the join point and after advice runs last on the way out, for synchronous and asynchronous join points alike.

`observableAdapter` (entry `nestjs-aspect/rxjs`) follows Observables. An Observable is lazy, so the adapter subscribes to nothing: it returns an Observable that subscribes to the source once per subscriber and runs the advice within that subscription.

- After-returning advice runs when the source completes, with the last value it emitted or `undefined` when it emitted none, and then the completion is delivered. Every value is forwarded as the source emits it.
- After-throwing advice runs on the error notification, and the same error is delivered afterwards.
- After advice runs once when the subscription ends: before the completion or the error is delivered, or when the subscriber unsubscribes first.
- A result that is never subscribed runs no after advice, and a result that is subscribed twice runs it twice.
- Before advice and the code of around advice run when the method is called, not at subscription.
- The root entry of the package does not load `rxjs`.

### 7.4 Scopes and instances

- **Targets** of every scope are advised: singleton, request-scoped, transient and durable.
- **Aspects and advisors** are singleton providers. One that is request-scoped or transient, by its own scope or because a dependency makes it so, is a validation error; without strict mode its advice raises `AspectNotReadyError` on every call, because no singleton instance exists. Per-request state belongs to the join point: advice resolves a request-scoped provider with `ModuleRef.resolve()` and `ContextIdFactory`, or reads it from a CLS store.
- **Aspects and advisors are never advised**, as in Spring.
- An aspect inherits the advice of a superclass without `@Aspect`; an aspect that extends another `@Aspect` class is rejected, because the advice of the superclass would run once for each of them.
- An aspect or advisor class registered in several modules has several provider instances. The instance of the first registration serves the advice, and the weaver warns.
- **`perTarget` and `perClass` aspects.** The provider instance of such an aspect serves no call. An instance per target object or per advised class is created at the first call that needs it, once the container has constructed the provider instance. Its constructor and `@Inject()` property dependencies are the singleton providers that `ModuleRef.get(token, { strict: false })` returns from the module that registers the aspect; an optional dependency no provider supplies is `undefined`. A dependency that is request-scoped, transient or missing is a validation error and fails the call. The instances are held weakly by their target object or class.
- **Introductions.** The delegate of a target is created with `new use()` on first use and held weakly by the target. An introduced member is not a join point. In an application that does not declare the introduction, an introduced member of a shared class runs the member the class already has, or raises `AspectUsageError` when only the introduction adds it.

### 7.5 Position in the Nest request pipeline

```
middleware -> guards -> interceptors (before) -> pipes -> [ advice chain -> route handler ]
           -> interceptors (after) -> exception filters
```

Advice on a route handler runs inside the Nest interceptors and after the pipes, so it sees the transformed arguments. An error advice throws reaches the exception filters like an error of the handler. Guards, interceptors, pipes, filters and middleware are classes of the container and can be advised themselves. Nest interceptors remain the tool for concerns of the transport layer; aspects apply to any method of any managed class, whatever the transport.

### 7.6 Bootstrap validation

Stage 2 validates the configuration in `AspectModule.onModuleInit`. The findings of one application are raised together as one `AspectConfigurationError`.

| Finding                                                                                                       | `strict: true` (default)     | `strict: false`                                     |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------- | --------------------------------------------------- |
| Advice decorators on a class without `@Aspect`                                                                | Error                        | Error                                               |
| An aspect or advisor supplied by a factory, value or alias provider                                           | Error                        | Error                                               |
| An aspect or advisor that is not a singleton                                                                  | Error                        | Warning; its advice raises `AspectNotReadyError`    |
| A `perTarget` or `perClass` aspect with a dependency that is no singleton provider                            | Error                        | Warning; the call raises `AspectConfigurationError` |
| An `@Advisor` instance without `advice` or with an `order` that is no number                                  | Error                        | Warning; the call raises `AspectConfigurationError` |
| A `requiresAdvice` annotation on a member no advisor handles, or on a member of a class that is never advised | Error that lists the members | Warning; the call raises `AspectConfigurationError` |
| A pointcut that matches no member of the application                                                          | Warning                      | Warning                                             |
| Different aspects or advisors with the same order, or without one, on one join point                          | Warning                      | Warning                                             |
| An aspect or advisor class registered in several modules                                                      | Warning                      | Warning                                             |
| A global module with an `onApplicationShutdown` hook imported before `AspectModule`                           | Warning                      | Warning                                             |

Errors outside stage 2, in every mode:

- While the module compiles: `AspectModule` registered more than once, or by two copies of the package in one application; an unknown `report` level; an aspect that extends another `@Aspect` class; an advice method that is not a method; an introduction that collides with a member or with another introduction; a member whose prototype cannot be redefined.
- When a decorator is applied: an advice decorator without a pointcut (usually a circular import), `@Advisor()` on a class without a static pointcut, `@DeclareParents` on an instance member or on a member whose type is no class, an invalid `order` or instantiation model.
- In `onModuleInit`: `forRootAsync` options that depend on a request-scoped or transient provider.
- At a call: asynchronous advice on a synchronous join point (`AspectUsageError`), a call before the aspect or advisor instance exists (`AspectNotReadyError`), an object that several applications advise ambiguously (`AspectUsageError`, section 5.5).

A validation failure closes the weaving context, because Nest runs no shutdown hook for an application whose initialization failed. After the validation the weaver logs the weaving report at the level of the `report` option, one line per member and advisor in chain order:

```
UserService.findById <- ResilienceAspect.retry (around, order 10)
UserService.findById <- AuditAspect.record (before, no order)
```

`AspectInspector` exposes the same information: `advisedMembers(type?)` and `advisorsOf(type, name, kind?)`. It reports static matches and lists nothing after shutdown.

### 7.7 Cost

- **Weaving** runs once per application: static matching over classes, members and advisors. The class filter of each advisor runs once per class, so an advisor that does not concern a class costs nothing per member.
- **Unadvised members** are not touched. A member no advisor matches has no stub.
- **An advised call** costs one lookup of the object in a `WeakMap` (the common case of an object with one known owner), one `Invocation` object, one frozen copy of the arguments, and the interceptors of the chain. Dynamic matchers run only where a pointcut declares them. The join point object is created on first access.
- **A stub without a live application**, as after shutdown, costs the lookup and a direct call of the original function.
- Per-object state exists only for `perTarget` aspects and for introductions.

---

## 8. Spring feature coverage

The table lists the features of Spring AOP and their state in `nestjs-aspect` 0.0.1.

| #   | Spring feature                                                                 | 0.0.1       | Notes                                                                                                                                  |
| --- | ------------------------------------------------------------------------------ | ----------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Aspects as container beans with dependency injection                           | Implemented | `@Aspect()` classes are providers with constructor and property injection.                                                             |
| F2  | Automatic aspect detection and weaving of every applicable bean                | Implemented | `AspectModule` detects aspects and advisors and weaves providers, controllers, enhancers and middleware.                               |
| F3  | Named, composable, shareable pointcuts                                         | Implemented | Constants composed with `and`, `or`, `not`, `P.all`, `P.any`.                                                                          |
| F4  | `execution`                                                                    | Partial     | `P.method`, `P.name`, `P.kind`. No modifier, return type or parameter type patterns (C1).                                              |
| F5  | `within`                                                                       | Implemented | `P.within` for types, `P.inModule` for the package form.                                                                               |
| F6  | `this` and `target`                                                            | Implemented | `P.target`; both designators denote the same object.                                                                                   |
| F7  | `args` with binding                                                            | Implemented | `P.args` with `P.ANY` and `P.REST`; the arguments are typed on `jp.args`.                                                              |
| F8  | `@annotation`, `@within`, `@target`, `@args`                                   | Partial     | `P.annotated`, `P.withinAnnotated`, `P.targetAnnotated`, with typed values through `jp.annotation`. `@args` is not implemented.        |
| F9  | `bean()`                                                                       | Implemented | `P.bean` over provider tokens, at class granularity.                                                                                   |
| F10 | Static and dynamic matching, cached chains                                     | Implemented | `isRuntime` and `matchesRuntime`; one chain per application and member.                                                                |
| F11 | Custom pointcuts, regular expressions, control flow                            | Partial     | `P.matching`, `P.name(RegExp)`, `P.bean(RegExp)`, `P.metadata`. A control flow pointcut is not implemented.                            |
| F12 | The five advice kinds                                                          | Implemented | Section 4.3, applied to the settled result of asynchronous join points.                                                                |
| F13 | Typed advice parameters                                                        | Implemented | The result, the error, the arguments and annotation values are typed from the pointcut.                                                |
| F14 | `proceed()`, `proceed(args)`, repeated proceed                                 | Implemented | `proceed()`, `proceedWith(...args)`, any number of times.                                                                              |
| F15 | `JoinPoint` API                                                                | Implemented | `target`, `args`, `signature`, `kind`, `isAsync`, `annotation`, `findAnnotation`, `introduced`, `toString`. There is no `StaticPart`.  |
| F16 | Ordering between aspects and within an aspect                                  | Implemented | Section 4.4; the cases Spring leaves undefined are defined.                                                                            |
| F17 | Low-level `Advisor` and `MethodInterceptor` API                                | Implemented | `@Advisor()`, `PointcutAdvisor`, `MethodInterceptor`, `MethodInvocation`.                                                              |
| F18 | Advice type extension through adapters                                         | Implemented | `AdviceAdapter` and the `adviceAdapters` option.                                                                                       |
| F19 | Introductions                                                                  | Implemented | `@DeclareParents`, per-target delegates, `isIntroduced`, `introduced`, `jp.introduced`. There is no programmatic introduction advisor. |
| F20 | Instantiation models                                                           | Implemented | `singleton`, `perTarget` (covers `perthis` and `pertarget`), `perClass` (`pertypewithin`).                                             |
| F21 | Programmatic proxies (`ProxyFactory`, `AspectJProxyFactory`)                   | No          | Aspects apply to container-managed classes only.                                                                                       |
| F22 | `Advised` inspection and manipulation                                          | Partial     | `AspectInspector` and the weaving report list advisors. The advice of a running application cannot be changed.                         |
| F23 | `TargetSource`                                                                 | No          | It requires a proxy object.                                                                                                            |
| F24 | `exposeProxy` and `AopContext.currentProxy()`                                  | Not needed  | Self-invocation is advised.                                                                                                            |
| F25 | Schema-style (configuration-defined) aspects                                   | No          | Aspects are declared with decorators; a library declares advisors with `@Advisor()`.                                                   |
| F26 | Proxy type control                                                             | Not needed  | There are no proxies.                                                                                                                  |
| F27 | Full AspectJ: objects outside the container, field and constructor join points | No          | A non-goal.                                                                                                                            |

Beyond the Spring feature list, 0.0.1 contains: annotations with a method contract and `requiresAdvice`; accessor join points; `ReturnValueAdapter` with `promiseAdapter` and `observableAdapter`; the bootstrap validation and the weaving report; isolation of several applications in one process.

---

## 9. Accepted limitations and open questions

### 9.1 Limitations

**Weaving time**

- A call made while the container instantiates providers, in a constructor or a provider factory, is not guaranteed to be advised. Before the weaver factory has run, it runs without advice; `forRootAsync` delays the weaver by the time its options take to resolve. After that, a call that reaches a stub before the instance of its aspect or advisor exists raises `AspectNotReadyError`.
- An application that is compiled and never initialized skips stage 2: the validation does not run, and the classes of factory and value provider instances are not woven.
- A middleware class that is not also a provider is woven after the router has bound its `use` method: `use` itself is not advised, the methods it calls are.
- The instance of a singleton factory or value provider is woven by its class in stage 2, so its advice is active from `AspectModule.onModuleInit` on.
- A global module imported before `AspectModule` runs its `onModuleInit` hooks before stage 2 and its `onApplicationShutdown` hooks after the context is closed.
- Modules loaded with `LazyModuleLoader` are not woven.

**What can be a join point**

- Arrow-function class fields and `#private` methods cannot be advised (C9).
- A class wrapped in a `Proxy` reads as a native function and is not woven.
- Aspects, advisors, module classes and the classes of the `exclude` option are never advised.
- An introduced member is not advised.

**Matching and types**

- There are no return type or parameter type patterns (C1).
- Type checking is structural: two classes with the same structure are interchangeable, and a broad pointcut such as `P.within` or `P.name` types arguments and results as `unknown`.
- For a join point that returns a value with a `subscribe` method, such as an Observable, the advice decorators accept asynchronous advice and type the result of after-returning advice as `any`: whether and how an adapter follows the value is known at run time.
- `requiresAdvice` is satisfied only by an advisor whose pointcut refers to the annotation or contains a caller-supplied matcher (section 6).
- `P.bean` selects a class, not one registration of it.

**Aspects**

- Aspects and advisors are class providers and singletons. A factory, value or alias provider that supplies one is rejected, and a replacement registered with `overrideProvider(...).useValue(...)` in a test is no aspect.
- `perTarget` and `perClass` aspects depend on singleton providers only, and introduction delegates are created without injection.
- The decorator metadata that names the token of an introduction requires `emitDecoratorMetadata`.
- The advice of a running application cannot be changed.

**Several applications in one process**

- An object created with `new`, with `ModuleRef.create()` or still under construction is advised by the one live application that advises its class. With several such applications it is attributed by the owner of the objects in its properties; when that fails, strict mode raises `AspectUsageError`.
- Attribution by dependencies is evidence, not proof: an object wired by hand with the singleton of another application is attributed to that application.
- An application that is abandoned without `close()` counts as live until it is garbage collected. Nest offers no hook for a failed bootstrap.
- An application without `AspectModule` has no weaving context: while another live application advises a class, the instances of that class in the application without the module are advised by it.

**Observables**

- Before advice and the code of around advice run when the method is called, not when the result is subscribed.
- After-returning advice receives the last emitted value at completion; it does not run per emission.
- Advice that runs because the subscriber unsubscribes is not awaited, and an error it throws leaves `unsubscribe()` as RxJS reports teardown errors.

### 9.2 Open questions

1. **Self-invocation.** Self-invocation is always advised. A Spring-compatible mode that skips advice for calls from inside the same object would need per-call bookkeeping in every advised call.
2. **Observable emissions.** Whether advice per emission is worth a second adapter interface, next to the completion-based semantics.
3. **Lazy-loaded modules.** Weaving on load needs either an explicit call after `LazyModuleLoader.load()` or a wrapper around the loader.
4. **Programmatic proxies.** A `createProxy(target, { aspects, advisors })` function would cover objects outside the container and `TargetSource`-like indirection, at the price of the proxy caveats this design avoids.
5. **Further designators.** `@args` (the run-time classes of the arguments carry an annotation) and a control flow pointcut based on `AsyncLocalStorage`.
6. **Earlier Nest majors.** The design uses `ModulesContainer`, `Reflector`, `ModuleRef` and the lifecycle hooks; the package targets NestJS 12 on Node.js 24.
