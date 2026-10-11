# nestjs-aspect

**Spring-style aspect-oriented programming for NestJS.** Aspects are Nest providers whose advice runs around the methods their pointcuts select.

[![npm version](https://img.shields.io/npm/v/nestjs-aspect)](https://www.npmjs.com/package/nestjs-aspect)
[![npm monthly downloads](https://img.shields.io/npm/dm/nestjs-aspect)](https://www.npmjs.com/package/nestjs-aspect)
[![CI](https://img.shields.io/github/actions/workflow/status/thilllon/nestjs-kit/ci.yml?branch=main)](https://github.com/thilllon/nestjs-kit/actions/workflows/ci.yml)

This package is being prepared for its first npm release and is not yet published on npm. The entry point exports the error classes listed below and the declarations of the aspect API; the aspect API functions are not implemented and throw when called.

Requires **Node.js 24+** and **NestJS 12**. Ships ESM, CommonJS, and TypeScript declarations.

## Exported errors

| Class                   | Thrown when                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `AopConfigurationError` | Aspects, pointcuts or advice are misconfigured; raised while the application bootstraps. |
| `AopUsageError`         | Advice is misused at run time, such as asynchronous advice on a synchronous join point.  |
| `AopNotReadyError`      | A woven method is invoked before the instance of an aspect that advises it exists.       |

## Planned API

The design maps the Spring AOP model onto NestJS:

- Aspects declared as Nest providers, with dependency injection and provider scopes.
- Pointcuts defined independently of the class hierarchy.
- Five advice kinds with Spring's semantics: before, after returning, after throwing, after (finally) and around.
- Advice ordering, introductions, aspect instantiation models and a low-level advisor API.
- Type checking from a pointcut to the advice signature and the advised method signature.
- Promise-aware advice, with other asynchronous return types such as `Observable` supported through extensions.
- Weaving at a defined point of application bootstrap, with configuration errors reported at bootstrap.

[docs/design.md](https://github.com/thilllon/nestjs-kit/blob/main/packages/nestjs-aspect/docs/design.md) specifies the API, the weaving model and the error behavior. [docs/spring-aop-analysis.md](https://github.com/thilllon/nestjs-kit/blob/main/packages/nestjs-aspect/docs/spring-aop-analysis.md) describes the Spring AOP model and the feature list the design maps to. [docs/sketch/api.ts](https://github.com/thilllon/nestjs-kit/blob/main/packages/nestjs-aspect/docs/sketch/api.ts) holds a type-level sketch of the public API, and [docs/spike](https://github.com/thilllon/nestjs-kit/tree/main/packages/nestjs-aspect/docs/spike) holds runnable experiments on weaving timing.

[Contributing](https://github.com/thilllon/nestjs-kit/blob/main/CONTRIBUTING.md) · [Release setup](https://github.com/thilllon/nestjs-kit/blob/main/docs/releases.md)
