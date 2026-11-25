---
"nestjs-aspect": major
---

Around advice returns only values that the join point produced. `joinPoint.proceed()` and `joinPoint.proceedWith(...args)` return `Proceeded<T>`, the declared result branded as produced by the join point, and `@Around` rejects advice that returns another value, such as a wrapper, a copy or a literal. `joinPoint.replaceResult(value)` returns a value that `proceed()` did not produce, such as a cache hit, a fallback or a skipped call, checked against the declared result. Explicit return annotations of around advice change from the result type to `ProceededOf<typeof pointcut>`, or `Proceeded<T>` (`Promise<Proceeded<unknown>>` for asynchronous advice on a join point whose result is unknown). New type exports: `Proceeded`, `ProceededOf` and `AroundResult`. Run-time behavior is unchanged.
