---
"nestjs-aspect": minor
---

Add the `async` option to `createAnnotation`. `createAnnotation("Timed", { async: true })` creates an annotation with the method contract `AsyncMethod`, `(...args: any[]) => Promise<unknown>`, and infers its name; an explicit contract is kept as given. Applying an `async` annotation throws `AspectConfigurationError` on an accessor and on a method whose emitted `design:returntype` is not a promise; on a class, it checks the methods with emitted `design:returntype`, which the compiler emits for decorated members only. Annotations expose the option as `annotation.async`.
