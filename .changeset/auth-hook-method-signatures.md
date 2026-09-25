---
"nestjs-slightly-better-auth": patch
---

`@BeforeAuth()`, `@AfterAuth()`, `@BeforeDatabase()` and `@AfterDatabase()` accept every method whose signature fits the hook: a method may declare fewer parameters, such as a one-parameter database hook or a parameterless endpoint hook, and return a narrower result, such as a `boolean` inferred from a delete hook. `HookMethodDecorator` and `DbHookMethodDecorator` infer the decorated method type and constrain it to `(ctx: AuthHookContext<P>) => unknown` or `DatabaseHookMethod<E, Ph>`. Before-hook bodies stay unvalidated, update payloads stay partial, a delete hook still cannot return replacement data, and a database hook must still accept a missing endpoint context.
