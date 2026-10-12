# Aspects around provider calls on NestJS

A NestJS HTTP application whose providers are advised by three aspects woven by [`nestjs-aspect`](../../README.md). It needs no external services: an in-memory `Database` stands in for a database client and an in-memory client for a remote inventory service.

Nest guards, interceptors, pipes and exception filters surround route handlers. The aspects of this example advise what lies behind the handlers: the calls from the service to the repository and to the inventory client, also when no request starts them.

The example shows:

- `TransactionAspect`, whose `@Around` advice runs a method annotated with `@Transactional()` in a transaction. An `AsyncLocalStorage` in `Database` carries the transaction to the repository calls of the method, and a failed method discards its writes;
- `RetryAspect`, whose `@Around` advice reads the value of `@Retryable({ attempts })` from the join point and repeats one call of the inventory client after a transient error, inside the transaction of the calling service method;
- `AuditAspect`, whose `@Before`, `@AfterReturning` and `@AfterThrowing` advice records the calls between the providers of `OrdersModule`. Its pointcut, `P.inModule(OrdersModule).and(P.within(OrdersController, Database).not())`, selects them without a decorator on any of them and leaves the route handlers to Nest;
- annotations that accept only methods returning a promise and fail the bootstrap when no advisor handles them;
- aspect order: `AuditAspect` (`order: 10`) runs outside `TransactionAspect` (`order: 15`) and `RetryAspect` (`order: 20`), so the outcome of a method is audited after its commit or rollback and a retried call is audited once;
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
curl http://localhost:3000/orders
curl http://localhost:3000/audit
```

The order succeeds on the third call of `InventoryClient.reserve`, and the audit trail holds one `call` and one `return` entry for that method. An order for `offline` answers `503` after three attempts: `OrdersService.place` has stored the order before the reservation fails, the transaction rolls back, and `GET /orders` does not list it. `GET /audit` is declared outside `OrdersModule`, so it adds no entry.

## Files

- `src/transactional.ts` declares the `Transactional` annotation; `src/retryable.ts` declares the `Retryable` annotation and `TransientError`.
- `src/transaction.aspect.ts`, `src/retry.aspect.ts` and `src/audit.aspect.ts` are the aspects; `src/audit-log.ts` is the provider `AuditAspect` injects.
- `src/database.ts` is the in-memory database with transactions.
- `src/orders.module.ts` declares the controller and the advised service, repository and inventory client.
- `src/app.module.ts` imports `AspectModule.forRoot()` first and registers the aspects as providers.
- `src/create-app.ts` creates the Nest application on the Express adapter; `src/main.ts` starts it.
- `src/create-app.test.ts` boots the application and checks the transactions, the retries and the audit trail. Run it from the repository root with `pnpm --filter nestjs-aspect-basic-example test`.
