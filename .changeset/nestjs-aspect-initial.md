---
"nestjs-aspect": patch
---

Add the `nestjs-aspect` package for Spring-style aspect-oriented programming in NestJS. It provides typed annotations (`createAnnotation`), the `P` pointcut designators with `and`, `or` and `not` composition, the `@Aspect`, `@Before`, `@After`, `@AfterReturning`, `@AfterThrowing` and `@Around` decorators with advice signatures checked against their pointcut, the `@Advisor` decorator with the `PointcutAdvisor` and `MethodInterceptor` interfaces, the `AdviceAdapter` and `ReturnValueAdapter` extension interfaces with the built-in `promiseAdapter`, and the `AspectConfigurationError`, `AspectUsageError` and `AspectNotReadyError` error classes.
