# Spring AOP - Full Analysis

Sources: the "Aspect Oriented Programming with Spring" and "Spring AOP APIs" chapters of the
Spring Framework reference (every subpage), current documentation (7.x). Content marked
**[source]** comes from the Spring Framework source code, not from a reference page.

---

## 1. Conceptual model

| Term              | Definition in Spring AOP                                                                                                                                               | Notes                                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Aspect**        | A modularization of a crosscutting concern. It is a regular class annotated with `@Aspect` (annotation style) or a POJO referenced from `<aop:aspect>` (schema style). | An aspect is a bean. It gets DI, lifecycle and `Ordered` as-is.                                       |
| **Join point**    | A point during execution. **In Spring AOP it is always a method execution.**                                                                                           | There are no field get/set, constructor, static initialization or handler join points (AspectJ only). |
| **Advice**        | The action taken at a join point. It is modeled as an _interceptor_, and Spring maintains a _chain_ of interceptors around the join point.                             | There are five kinds. See §4.                                                                         |
| **Pointcut**      | A predicate over join points. Advice is bound to a pointcut.                                                                                                           | Uses the AspectJ expression language by default.                                                      |
| **Introduction**  | Declaring additional interfaces (+ an implementation) on behalf of a type. AspectJ calls it an inter-type declaration.                                                 | `@DeclareParents`, `IntroductionAdvisor`.                                                             |
| **Target object** | The object the advice applies to (the "advised object").                                                                                                               | In Spring AOP it is always proxied.                                                                   |
| **AOP proxy**     | An object the framework creates to implement the aspect contracts. It is a JDK dynamic proxy or a CGLIB subclass.                                                      | The proxy is a _different object_ from the target.                                                    |
| **Weaving**       | Linking aspects with application objects. Compile time / load time / **runtime**.                                                                                      | Spring AOP weaves at runtime by creating proxies.                                                     |
| **Advisor**       | A Spring-specific concept: one advice + one pointcut.                                                                                                                  | Every `@Aspect` advice method becomes one Advisor internally.                                         |

Design principles the reference states:

1. **It complements OOP, it does not replace it.** The unit of modularity is the aspect.
2. **It is not a complete AOP implementation.** The goal is tight integration with the IoC container
   for typical enterprise problems (transactions, security, caching).
3. **Non-invasiveness.** Business code should not depend on framework types. The framework still
   offers opt-in coupling for the cases where that reads better.
4. **Use the weakest advice that works.** For example, populating a cache uses `@AfterReturning`
   instead of `@Around`. Forgetting `proceed()` is then impossible by construction.
5. **Statically typed advice parameters.** Advice declares the parameters it needs
   (`returning`, `throwing`, bound arguments) instead of handling `Object[]`.
6. **Pointcuts are independent of the OO hierarchy.** This is what distinguishes AOP from plain interception.

---

## 2. Programming models

Spring provides four layers. All of them end up as the same runtime artifact: a proxy holding an
ordered list of **advisors**.

| Layer                         | How aspects are declared                                                                                                                                                                                                       | Notes                                                                                                                                                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **@AspectJ annotation style** | An `@Aspect` class with `@Pointcut`, `@Before`, `@AfterReturning`, `@AfterThrowing`, `@After`, `@Around`, `@DeclareParents`. Enabled with `@EnableAspectJAutoProxy`.                                                           | Recommended by the Spring team. Supports every instantiation model and named pointcut composition. `aspectjweaver` is needed only as the expression parser/matcher.                                                            |
| **Schema (XML) style**        | `<aop:config>`, `<aop:aspect ref>`, `<aop:pointcut>`, `<aop:before method=…>`, `<aop:advisor>`, `<aop:declare-parents>`.                                                                                                       | Based on plain POJOs. Supports only the singleton instantiation model, and named pointcuts declared in XML cannot be composed. Knowledge about the concern is split between the class and the configuration (a DRY violation). |
| **Low-level Spring AOP API**  | `Pointcut` (`ClassFilter` + `MethodMatcher`), `Advice` (`MethodInterceptor`, `MethodBeforeAdvice`, `AfterReturningAdvice`, `ThrowsAdvice`), `Advisor`, `ProxyFactory`/`ProxyFactoryBean`, auto-proxy creators, `TargetSource`. | The infrastructure (transactions, caching, `@Async`, `@Validated`, method security) is built on top of it.                                                                                                                     |
| **Full AspectJ**              | The AspectJ compiler (CTW) or load-time weaving (`@EnableLoadTimeWeaving`), `@Configurable` for objects created with `new`.                                                                                                    | Bytecode weaving: no proxy, no self-invocation problem, every kind of join point. Outside the scope of Spring AOP.                                                                                                             |

**How @AspectJ becomes runtime behavior [source]:**

1. `@EnableAspectJAutoProxy` registers `AnnotationAwareAspectJAutoProxyCreator`, a
   `BeanPostProcessor` (precisely, a `SmartInstantiationAwareBeanPostProcessor`).
2. `BeanFactoryAspectJAdvisorsBuilder` finds every bean whose class is annotated with `@Aspect`.
   `ReflectiveAspectJAdvisorFactory` converts each advice method into an
   `InstantiationModelAwarePointcutAdvisorImpl` (pointcut = `AspectJExpressionPointcut`,
   advice = `AspectJAroundAdvice` / `AspectJMethodBeforeAdvice` / `AspectJAfterAdvice` /
   `AspectJAfterReturningAdvice` / `AspectJAfterThrowingAdvice`).
3. For every bean, in `postProcessAfterInitialization` → `wrapIfNecessary`:
   `findEligibleAdvisors` filters the advisors whose pointcut _can_ match some method of the bean
   class (`AopUtils.canApply`), sorts them (`AspectJPrecedenceComparator`), prepends
   `ExposeInvocationInterceptor`, then creates the proxy with `ProxyFactory`.
   No applicable advisor means no proxy.
4. Circular references: `getEarlyBeanReference` creates the proxy early so that the beans in the
   cycle receive the proxy, not the raw target.
5. At invocation time the proxy (`JdkDynamicAopProxy` / `CglibAopProxy`) asks
   `AdvisedSupport.getInterceptorsAndDynamicInterceptionAdvice(method, targetClass)`
   (**cached per method**) for the chain. A static match becomes a plain interceptor, and a dynamic
   match becomes an `InterceptorAndDynamicMethodMatcher` that rechecks the arguments on every call.
6. `ReflectiveMethodInvocation.proceed()` walks the chain by index and finally invokes the target
   method reflectively. `ProceedingJoinPoint.proceed()` in `@Around` advice uses an
   _invocable clone_ of the invocation, so `proceed()` can be called several times (retry). Each call
   runs the rest of the chain again.
7. Aspects are excluded from auto-proxying: **an aspect cannot be advised by another aspect.**

**Infrastructure features are advisors, not @Aspect classes [source].**
`@Transactional` = `BeanFactoryTransactionAttributeSourceAdvisor` (pointcut:
`TransactionAttributeSourcePointcut`, advice: `TransactionInterceptor`). `@Cacheable`,
method security (`@PreAuthorize`) and Spring 7 resilience (`@Retryable`, `@ConcurrencyLimit`) follow
the same pattern. `@Async`/`@Validated` use `AbstractAdvisingBeanPostProcessor`, which adds one
advisor to an existing proxy or creates a new proxy. The attribute-based pointcut + interceptor pair
is the extension point library authors use, and `@Aspect` is an application-level convenience.

---

## 3. Pointcuts

### 3.1 Pointcut API

```java
public interface Pointcut {
    ClassFilter getClassFilter();
    MethodMatcher getMethodMatcher();
}
public interface ClassFilter { boolean matches(Class<?> clazz); }
public interface MethodMatcher {
    boolean matches(Method m, Class<?> targetClass);             // static
    boolean isRuntime();
    boolean matches(Method m, Class<?> targetClass, Object... args); // dynamic
}
```

- It is split into a class part and a method part, so each can be reused and composed.
- **Static** matching (`isRuntime() == false`) is evaluated once per (method, class) pair and cached
  at proxy creation / first invocation. Recommended in almost every case.
- **Dynamic** matching: the two-argument `matches` runs first. If it returns true and `isRuntime()`
  holds, the three-argument version runs with the actual arguments **on every call**.
- **Composition**: the `Pointcuts` static helpers or `ComposablePointcut` build unions and intersections.
  Union is "usually more useful".
- **Convenience implementations**:
  - `JdkRegexpMethodPointcut` - a regular expression over the fully qualified method name. It is the
    union of its patterns. `RegexpMethodPointcutAdvisor` combines it with an advice.
  - Attribute/metadata-driven static pointcuts (for example `AnnotationMatchingPointcut`,
    `TransactionAttributeSourcePointcut`).
  - `ControlFlowPointcut` - dynamic, matches the current call stack ("called from class X / package Y").
    About 5 times as expensive as other dynamic pointcuts. Weaker than AspectJ `cflow`.
  - The superclasses for custom pointcuts, `StaticMethodMatcherPointcut` and `DynamicMethodMatcherPointcut`.
- Since 2.0 `AspectJExpressionPointcut` is the most important implementation.

### 3.2 AspectJ pointcut designators supported by Spring AOP

| PCD                   | Matches                                                                                                                           | Static/dynamic      | Binding form          |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------- | --------------------- |
| `execution(...)`      | Matches method executions by modifier, return type, declaring type, name, parameters and throws. The primary PCD.                 | Static              | -                     |
| `within(TypePattern)` | Methods declared in the matching types / packages (`com.xyz.service..*`).                                                         | Static              | -                     |
| `this(Type)`          | The **proxy** is an instance of Type.                                                                                             | Static (type-based) | Binds the proxy       |
| `target(Type)`        | The **target** is an instance of Type.                                                                                            | Static              | Binds the target      |
| `args(Types…)`        | The runtime arguments are instances of the given types. Differs from `execution(* *(Type))`, which checks the declared signature. | Dynamic             | Binds the arguments   |
| `@target(Ann)`        | The runtime class of the target has the annotation.                                                                               | Mostly static       | Binds the annotation  |
| `@within(Ann)`        | The declaring type has the annotation.                                                                                            | Static              | Binds the annotation  |
| `@annotation(Ann)`    | The executing method has the annotation.                                                                                          | Static              | Binds the annotation  |
| `@args(Ann…)`         | The runtime types of the actual arguments have the annotations.                                                                   | Dynamic             | Binds the annotations |
| `bean(nameOrPattern)` | Spring only. A bean name with `*` wildcards. Instance level, not type level.                                                      | Static              | -                     |

Unsupported (throw `IllegalArgumentException`): `call`, `get`, `set`, `preinitialization`,
`staticinitialization`, `initialization`, `handler`, `adviceexecution`, `withincode`,
`cflow`, `cflowbelow`, `if`, `@this`, `@withincode`.

**`execution` syntax:**

```
execution(modifiers-pattern? ret-type-pattern declaring-type-pattern?name-pattern(param-pattern) throws-pattern?)
```

- Required: the return type pattern, the name pattern and the parameter pattern.
- Names/types use the `*` wildcard; packages (subpackages) and parameters (zero or more) use `..`.
  `(*)` is exactly one parameter of any type, `(*,String)`, `Type+` = that type or a subtype.
- Examples: `execution(public * *(..))`, `execution(* set*(..))`,
  `execution(* com.xyz.service.AccountService.*(..))`, `execution(* com.xyz.service..*.*(..))`.

**Visibility.** Calls inside the target object are not intercepted (proxy). A JDK proxy intercepts
only public interface methods, and CGLIB intercepts public and protected ones (package-visible too
if needed). A pointcut intended to be public-only must express that explicitly.

### 3.3 Named pointcuts and sharing

- `@Pointcut("expr") void name() {}` - the method acts as the _signature_ and the annotation holds the
  _expression_.
- Compose with `&&`, `||`, `!` and by name: `@Pointcut("publicMethod() && inTrading()")`.
- Best practice: build complex pointcuts from small named pointcuts. Keep a shared `CommonPointcuts`
  class (`inWebLayer()`, `inServiceLayer()`, `businessService()`, `dataAccessOperation()`) and
  reference it by fully qualified name from any aspect or from XML
  `<aop:advisor pointcut="com.xyz.CommonPointcuts.businessService()">`.
- Java visibility rules apply when _referencing_ a named pointcut but not to matching.

### 3.4 Writing good pointcuts

AspectJ rewrites a pointcut into DNF and evaluates the cheap parts first. A good pointcut still
includes the following.

- A **kinded** designator (`execution`),
- A **scoping** designator (`within`) - the cheapest, it rules out whole groups quickly,
- Optionally a **contextual** designator (`this`, `target`, `@annotation`) to match or bind.

### 3.5 Binding and argument names

- `args(account,..)` both restricts (the first parameter must be an `Account`) and binds to the advice
  parameter `account`. The same holds for `this`, `target`, `@within`, `@target`, `@annotation`, `@args`.
- A named pointcut can "provide" bound values:
  `@Pointcut("… && args(account,..)") void op(Account account) {}` followed by `@Before("op(account)")`.
- Name resolution (the `ParameterNameDiscoverer` chain): the explicit `argNames` attribute →
  Kotlin reflection → the `-parameters` javac flag (recommended) → deduction from the pointcut.
  If all of them fail, an exception is thrown.
- A first parameter of type `JoinPoint`, `ProceedingJoinPoint` or `JoinPoint.StaticPart` is
  implicit and can be omitted from `argNames`.
- Generics: `args(param)` with a `MyType` parameter works for `Sample<T>.method(T)` but not for
  collections (`Collection<MyType>`), because every element would have to be inspected.

---

## 4. Advice

### 4.1 Semantics

| Advice             | When it runs                    | Can it prevent the call?           | Sees the return value | Can replace the return value                 | Sees the exception    | Notes                                                                                                                                                                                                                                                                                 |
| ------------------ | ------------------------------- | ---------------------------------- | --------------------- | -------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@Before`          | Before the join point           | Only by throwing an exception      | No                    | No                                           | No                    | Cannot forget to proceed.                                                                                                                                                                                                                                                             |
| `@AfterReturning`  | After a normal return           | -                                  | Yes (`returning="v"`) | **No** (cannot return a different reference) | No                    | The `returning` type _also restricts matching_ (for example only methods returning `Account`). If the advice throws, that exception replaces the return value.                                                                                                                        |
| `@AfterThrowing`   | After exiting with an exception | -                                  | No                    | -                                            | Yes (`throwing="ex"`) | The `throwing` type _restricts matching_. It is not a general error handler: it receives only exceptions raised by the join point itself, not exceptions from the accompanying `@After`/`@AfterReturning` advice. If this advice throws, the new exception replaces the original one. |
| `@After` (finally) | Always on exit                  | -                                  | No                    | No                                           | No                    | Same as a `finally` block. For releasing resources.                                                                                                                                                                                                                                   |
| `@Around`          | Before and after                | **Yes** (by not calling `proceed`) | Yes                   | **Yes**                                      | Yes                   | Must return `Object`. `void` around advice always gives the caller `null`. `proceed()` can be called zero times, once or several times. `proceed(Object[])` replaces the arguments. Typical uses: timing, caching, retry, transactions.                                               |

Difference between AspectJ and Spring: in around advice compiled by AspectJ, `proceed(args)` must
match the bound arguments of the advice, whereas Spring takes the arguments of the target method as-is.
A portable pattern: bind every method parameter in order (`args(a,b)`) and pass them to `proceed` unchanged.

### 4.2 JoinPoint API

`getArgs()`, `getThis()` (the proxy), `getTarget()` (the target), `getSignature()` (the advised
method), `toString()`. `ProceedingJoinPoint` adds `proceed()` / `proceed(Object[])`.
`JoinPoint.StaticPart` exposes only static information (cheap).

### 4.3 Ordering

- **Between aspects:** precedence is set by `Ordered.getOrder()` or `@Order` on the aspect class.
  A lower value means higher precedence. When unspecified, **the order is undefined**.
- **On the way in** the highest precedence runs first. **On the way out** the highest precedence
  runs last (the onion model).
- **Within one aspect** (since 5.2.7): precedence by advice kind, from highest to lowest,
  `@Around`, `@Before`, `@After`, `@AfterReturning`, `@AfterThrowing`. `@After` is
  "after finally", so it effectively runs _after_ the `@AfterReturning`/`@AfterThrowing` of the same
  aspect. The resulting chain, outer → inner:
  `Around → Before → After(finally) → AfterReturning → AfterThrowing → target`.
  That is why `@AfterThrowing` sees only join point exceptions.
- **Two of the same kind in one aspect:** undefined (javac reflection does not preserve declaration order).
  Recommendation: merge them into one or split them into separately ordered aspects.
- Advisors (low-level API) also use `Ordered`. The default is unordered.

### 4.4 Low-level advice API

| Interface                          | Shape                                                                        | Notes                                                                                                                            |
| ---------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `MethodInterceptor` (AOP Alliance) | `Object invoke(MethodInvocation inv)`                                        | The most fundamental. `inv.proceed()` continues the chain. Interoperates with other AOP Alliance frameworks (not the pointcuts). |
| `MethodBeforeAdvice`               | `void before(Method, Object[] args, Object target)`                          | Throwing stops the chain. A checked exception absent from the signature is wrapped (`UndeclaredThrowableException`).             |
| `ThrowsAdvice`                     | Marker. Methods `afterThrowing([Method, args, target,] SubclassOfThrowable)` | Typed by the exception parameter. One class can handle several exception types. Throwing here overrides the original exception.  |
| `AfterReturningAdvice`             | `void afterReturning(Object ret, Method, Object[] args, Object target)`      | Cannot modify the return value.                                                                                                  |
| `IntroductionInterceptor`          | `MethodInterceptor` + `implementsInterface(Class)`                           | Must handle the introduced methods itself (no `proceed`).                                                                        |

New advice types are added through the `AdvisorAdapterRegistry` SPI (`org.springframework.aop.framework.adapter`):
an adapter converts an `Advice` into a `MethodInterceptor`. The only requirement is the
`org.aopalliance.aop.Advice` marker.
**[source]** Built-in adapters: `MethodBeforeAdviceAdapter`, `AfterReturningAdviceAdapter`,
`ThrowsAdviceAdapter`. AspectJ around/after/after-throwing advice is already an
interceptor.

### 4.5 Advice lifecycle

Each advice is a bean. There is **per-class** advice (shared, stateless - the common case, for example
transactions) and **per-instance** advice (adds state to the proxied object - required for
introductions/mixins). The two can be mixed in one proxy.

---

## 5. Advisors

- Advisor = exactly one advice + one pointcut (a "very small aspect").
- `DefaultPointcutAdvisor` works with `MethodInterceptor`, `BeforeAdvice` and `ThrowsAdvice`.
- Different kinds of advice can be mixed in one proxy, and Spring builds the chain.
- Advice added without a pointcut is wrapped in an advisor whose pointcut matches everything.
- `IntroductionAdvisor` has only a `ClassFilter` (an introduction is class level) and additionally
  has `getInterfaces()` and `validateInterfaces()`.
- `DefaultAdvisorAutoProxyCreator` automatically applies **every applicable advisor in the context**.
  Deciding applicability needs a pointcut, so advisors (not bare advice) are required.
  It supports filtering by name prefix and ordering through `Ordered`.

---

## 6. Introductions

- `@DeclareParents(value = "com.xyz.service.*+", defaultImpl = DefaultUsageTracked.class) public static UsageTracked mixin;` -
  matching beans now implement `UsageTracked`. The type of the field selects the interface, and
  `value` is an AspectJ _type pattern_.
- Advice can bind the introduced view: `@Before("… && this(usageTracked)")`.
- Callers can obtain the bean as the introduced type:
  `ctx.getBean("myService", UsageTracked.class)`.
- Low level: `DelegatingIntroductionInterceptor` delegates the introduced methods to a delegate
  (default: itself), auto-detects the interfaces, and hides some with `suppressInterface(...)`.
  `DefaultIntroductionAdvisor(new LockMixin(), Lockable.class)`.
- **An introduction is stateful → per-instance advisor.** Each advised object needs its own
  mixin instance.
- An introduced interface **hides** the target's own implementation of the same interface.
- An introduction advisor cannot be added to or removed from an existing proxy (because the interfaces
  of the proxy do not change). A new proxy must be obtained instead.

---

## 7. Aspect instantiation models

| Model                        | Meaning                                                                 | Spring support |
| ---------------------------- | ----------------------------------------------------------------------- | -------------- |
| `singleton` (default)        | One aspect instance per container.                                      | Yes            |
| `perthis(pc)`                | One aspect instance per unique _proxy_ (`this`) at matched join points. | Yes            |
| `pertarget(pc)`              | One aspect instance per unique _target_.                                | Yes            |
| `pertypewithin(TypePattern)` | One instance per matched type.                                          | Yes            |
| `percflow`, `percflowbelow`  | Per control flow.                                                       | **No**         |

A per-instance aspect is **created lazily at the first matched invocation** on that object. No
advice runs before that. It goes out of scope together with the object. The schema style supports
only singleton.

---

## 8. Proxy mechanism

### 8.1 JDK vs CGLIB

- The target implements one or more interfaces → a JDK dynamic proxy for **all** of them. Otherwise
  a CGLIB subclass.
- Forcing class-based proxies: `proxyTargetClass = true` (`@EnableAspectJAutoProxy`,
  `<aop:config proxy-target-class>`, `<aop:aspectj-autoproxy>`, `<tx:annotation-driven>`).
  All of these collapse into **one unified auto-proxy creator** that applies the _strongest_ setting.
  Since 7.0 `@EnableAsync` and similar also participate.
- Since 7.0: per-bean `@Proxyable(INTERFACES | TARGET_CLASS)` and `@Proxyable(interfaces = …)`
  override the global default.
- CGLIB limitations: a `final` class cannot be proxied. `final`/`private`/invisible
  package-private methods cannot be advised. The constructor is not called twice (Objenesis).
  Java module system restrictions apply.

### 8.2 Self-invocation (the key caveat)

A call through a _reference_ goes through the proxy. Once inside the target, however, `this.bar()`
calls the target directly - **advice is bypassed**. Remedies, in Spring's order of preference:

1. Refactor so that self-invocation does not happen.
2. Self-injection: call through an injected proxy reference.
3. `AopContext.currentProxy()` - requires `exposeProxy = true` (ThreadLocal) and couples the code
   to Spring AOP. "Strongly discouraged".

AspectJ CTW/LTW does not have this problem (bytecode weaving).

### 8.3 Proxy configuration (`ProxyConfig` / `ProxyFactoryBean`)

`proxyTargetClass`, `optimize` (CGLIB only), `frozen` (the configuration can no longer change),
`exposeProxy` (ThreadLocal for `AopContext`), and on `ProxyFactoryBean` `proxyInterfaces`,
`interceptorNames` (given by name so that prototype advisors work), `singleton`. An inner-bean
definition hides the raw target from the container.

### 8.4 Programmatic proxies

- `ProxyFactory`: `new ProxyFactory(target)`, `addAdvice`, `addAdvisor`, `getProxy()`.
  No IoC required. Has convenience methods for before/throws advice.
- `AspectJProxyFactory`: `addAspect(Class | instance)` - applies `@AspectJ` aspects to an arbitrary
  object.

### 8.5 `Advised` - runtime manipulation

Every proxy can be cast to `Advised`: `getAdvisors()`, `addAdvice([pos,] advice)`,
`addAdvisor([pos,] advisor)`, `indexOf`, `removeAdvisor`, `replaceAdvisor`, `isFrozen()`.
Bare advice appears wrapped in a `DefaultPointcutAdvisor` that matches everything. Introductions
cannot be added/removed after creation. Production use is "questionable". It is very useful in tests
(for example inspecting the state inside a transaction before rollback). `frozen` blocks modification
(for example preventing removal of a security interceptor).

### 8.6 Auto-proxying

Built on `BeanPostProcessor`. `BeanNameAutoProxyCreator` (names/wildcards +
`interceptorNames`), `DefaultAdvisorAutoProxyCreator` (every applicable advisor). The benefit:
callers can never obtain an un-advised object from the container.

### 8.7 TargetSource

The proxy asks the `TargetSource` for the target **on every call**.

| Implementation                                             | Use                                                                                                                |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `SingletonTargetSource` (default)                          | The same target on every call.                                                                                     |
| `HotSwappableTargetSource`                                 | `swap(newTarget)` at runtime. Callers keep their reference. Thread-safe.                                           |
| `CommonsPool2TargetSource` / `AbstractPoolingTargetSource` | A pool of prototype targets (`maxSize`). `PoolingConfig` is exposed through an introduction. "Usually not needed." |
| `PrototypeTargetSource`                                    | A new target per call (high wiring cost).                                                                          |
| `ThreadLocalTargetSource`                                  | A target per thread. Spring handles the cleanup.                                                                   |

A custom TargetSource usually needs a prototype-scoped target bean.

---

## 9. Choosing a style

- **Spring AOP vs AspectJ:** "use the simplest thing that can work". Spring AOP is enough for method
  executions on container beans. Objects outside the container (domain objects) and non-method join
  points (fields, constructors) need AspectJ.
- **@AspectJ vs XML:** XML keeps the pointcut in configuration (good when the pointcut is a setting that
  changes independently). It scatters the knowledge, however, supports only singleton aspects, and
  cannot compose named pointcuts. @AspectJ keeps the aspect as one module and is portable to full AspectJ.
- Styles can be mixed within one application (annotation aspects, schema aspects, advisors,
  other proxies/interceptors). They all come down to the same proxy infrastructure.

---

## 10. Full AspectJ integration (outside the scope of Spring AOP proper)

- `@Configurable` + `@EnableSpringConfigured`: dependency injection for objects created with `new`
  (domain objects). Works by AspectJ weaving of constructors.
- Load-time weaving: `@EnableLoadTimeWeaving`, `META-INF/aop.xml`, an instrumentation agent.
- Aspects compiled with `ajc` can still be configured as Spring beans
  (`factory-method="aspectOf"`).

These provide constructor/field/call join points and remove the self-invocation constraint at the cost of a weaving step.

---

## 11. Pitfalls and implicit contracts worth carrying over

1. **Self-invocation bypasses advice** (the proxy model). The most common `@Transactional` bug.
2. **Proxy ≠ target** identity: `this` and `target` differ. Delegating `equals`/`hashCode` matters.
   Casting to the concrete class fails with a JDK proxy.
3. **The order is undefined** without `@Order`, and between advice of the same kind within one aspect.
4. **The `@AfterThrowing` scope** changed in 5.2.7 to join point exceptions only.
5. **Matching based on return type** (the `returning` / `throwing` type restricts matching).
6. **Silent non-matching:** a pointcut with a typo matches nothing and gives no warning.
7. **Asynchronous return types:** regular @AspectJ advice sees `CompletableFuture`/`Mono` as an ordinary
   return value - `@AfterReturning` receives the future, and `@AfterThrowing` never runs for an
   asynchronous failure. Only the infrastructure interceptors (transactions, caching) adapt to
   reactive/coroutine return types **[source: `ReactiveAdapterRegistry`]**.
8. **Aspects are not advised by other aspects.**
9. **Proxy creation happens after initialization** - calls made inside the bean's own initialization
   callbacks do not go through the proxy.
10. **Checked exceptions** thrown by advice that are absent from the target signature become
    `UndeclaredThrowableException`.

---

## 12. Feature list (checklist for the NestJS design)

| #   | Spring feature                                                                    | Category     |
| --- | --------------------------------------------------------------------------------- | ------------ |
| F1  | `@Aspect` aspects as container beans that receive DI                              | Aspect       |
| F2  | Automatic aspect detection / auto-proxying of every applicable bean               | Weaving      |
| F3  | Named, composable and shareable pointcuts                                         | Pointcut     |
| F4  | `execution` (name/parameter/return/declaring type patterns)                       | Pointcut     |
| F5  | `within` (type / package)                                                         | Pointcut     |
| F6  | `this` / `target`                                                                 | Pointcut     |
| F7  | `args` (runtime, with binding)                                                    | Pointcut     |
| F8  | `@annotation`, `@within`, `@target`, `@args` (with binding)                       | Pointcut     |
| F9  | `bean(name*)`                                                                     | Pointcut     |
| F10 | Static vs dynamic matching, cached chains                                         | Pointcut     |
| F11 | Custom pointcuts (ClassFilter + MethodMatcher), regular expressions, control flow | Pointcut     |
| F12 | Five advice kinds with exact semantics                                            | Advice       |
| F13 | Typed advice parameters (`returning`, `throwing`, binding)                        | Advice       |
| F14 | `proceed()` / `proceed(args)`, multiple proceed                                   | Advice       |
| F15 | JoinPoint / StaticPart API                                                        | Advice       |
| F16 | Ordering: aspect precedence + per-kind order within an aspect                     | Advice       |
| F17 | Low-level Advice/Advisor API, `MethodInterceptor`                                 | API          |
| F18 | Advice type extension SPI (adapters)                                              | API          |
| F19 | Introductions (`@DeclareParents`, delegating mixins, per-instance state)          | Introduction |
| F20 | Instantiation models: singleton, perthis, pertarget, pertypewithin                | Aspect       |
| F21 | Programmatic proxies (`ProxyFactory`, `AspectJProxyFactory`)                      | API          |
| F22 | `Advised` inspection/manipulation, `frozen`                                       | API          |
| F23 | `TargetSource` (hot swap, pool, prototype, thread-local)                          | API          |
| F24 | `exposeProxy` / `AopContext.currentProxy()`                                       | API          |
| F25 | Schema-style (configuration-defined) aspects                                      | Style        |
| F26 | Proxy type control (`proxyTargetClass`, `@Proxyable`)                             | Weaving      |
| F27 | Full AspectJ: objects outside the container, field/constructor join points        | Out of scope |
