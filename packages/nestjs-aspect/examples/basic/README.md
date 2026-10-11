# Retry and audit aspects on NestJS

A NestJS HTTP application whose cross-cutting behavior lives in two aspects woven by [`nestjs-aspect`](../../README.md). It needs no external services: an in-memory client stands in for a remote inventory service.

The example shows:

- an annotation, `@Retryable({ attempts })`, that accepts only methods returning a promise and fails the bootstrap when no advisor handles it: one whose pointcut refers to the annotation;
- `RetryAspect`, whose `@Around` advice reads the annotation value from the join point and calls the method again after a transient error;
- `AuditAspect`, whose `@Before`, `@AfterReturning` and `@AfterThrowing` advice records every call into `OrdersModule`, selected with `P.inModule(OrdersModule)`, through an injected `AuditLog` provider;
- aspect order: `AuditAspect` (`order: 10`) runs outside `RetryAspect` (`order: 20`), so a retried call is audited once;
- `AspectInspector`, which lists the advice of a method.

## Run

From the repository root:

```sh
pnpm install
pnpm exec turbo run build --filter nestjs-aspect-basic-example
pnpm --filter nestjs-aspect-basic-example start
```

The Turbo build compiles `nestjs-aspect` before the example. The application listens on port 3000; `PORT` selects another port.

## Try it

Place an order. The SKU selects how the inventory client behaves: `flaky` fails twice before each success, `offline` fails every time and any other SKU succeeds.

```sh
curl --header "content-type: application/json" \
  --data '{"sku":"flaky","quantity":2}' \
  http://localhost:3000/orders
curl http://localhost:3000/audit
```

The order succeeds on the third call of `InventoryClient.reserve`, and the audit trail holds one `call` and one `return` entry for it. An order for `offline` answers `503` after three attempts and adds an `error` entry for each layer. `GET /audit` is declared outside `OrdersModule`, so it adds no entry.

## Files

- `src/retryable.ts` declares the `Retryable` annotation and `TransientError`.
- `src/retry.aspect.ts` and `src/audit.aspect.ts` are the aspects; `src/audit-log.ts` is the provider `AuditAspect` injects.
- `src/orders.module.ts` declares the advised controller, service and inventory client.
- `src/app.module.ts` imports `AspectModule.forRoot()` first and registers the aspects as providers.
- `src/create-app.ts` creates the Nest application on the Express adapter; `src/main.ts` starts it.
- `src/create-app.test.ts` boots the application and checks the retries and the audit trail. Run it from the repository root with `pnpm --filter nestjs-aspect-basic-example test`.
