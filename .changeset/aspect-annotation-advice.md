---
"nestjs-aspect": minor
---

Accept an annotation in place of a pointcut in `@Before`, `@After`, `@AfterReturning`, `@AfterThrowing` and `@Around`. `@Around(Timed)` is `@Around(Pointcut.annotated(Timed))`, for annotations created by `createAnnotation()` and `Reflector.createDecorator()`. `JoinPointOf<typeof Timed>` and `ProceedingJoinPointOf<typeof Timed>` type the join point as `Pointcut.annotated(Timed)` does, so `joinPoint.annotation(Timed)` is guaranteed and the method contract of the annotation types the arguments and the result. The new `AnnotatedShape` type names the shape of `Pointcut.annotated()`. The Quick start of the README starts with a minimal example; the audit log becomes the full example.
