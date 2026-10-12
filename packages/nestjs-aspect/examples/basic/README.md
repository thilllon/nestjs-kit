# Aspects around provider calls on NestJS

A NestJS HTTP application whose providers are advised by three aspects woven by [`nestjs-aspect`](../../README.md). It needs no external services: an in-memory `Database` stands in for a database client with serializable transactions, and `InMemoryInventory` for a remote inventory service.

Nest guards, interceptors, pipes and exception filters surround route handlers. The aspects of this example advise what lies behind the handlers: the calls from the services to the repositories and to the inventory client. A worker makes the same calls on a timer, without a request.

## What it does

`POST /orders` stores an order as pending, reserves its stock at the inventory service and confirms the order. No transaction is open during the remote call. An order whose reservation got no answer stays pending, and `ReconciliationWorker` completes it later; an order the inventory service refuses is cancelled.

- **`TransactionAspect`** (`order: 100`) runs a method annotated with `@Transactional()` in a transaction. `OrdersService.create`, `confirm` and `cancel` carry the annotation: each writes the order and its event, and a failure of the second write discards the first. An `AsyncLocalStorage` in `Database` carries the transaction to the repositories.
- **`RetryAspect`** (`order: 20`) repeats a method annotated with `@Retryable({ attempts, backoffMilliseconds })` after a `TransientError`, and waits a random time below a doubling limit before each further attempt. Two kinds of method carry the annotation, and both are safe to repeat:
  - `InventoryClient.reserve` sends the order id as its idempotency key, so the inventory service answers a repeated request with the reservation it already made.
  - The three methods of `OrdersService` fail with a `ConflictError`, which is a `TransientError`, when a concurrent transaction has changed the order they read. The aspect is outside `TransactionAspect`, so each attempt runs in a new transaction.
- **`StatisticsAspect`** (`order: 10`) records the number, the failures and the duration of the calls at the boundaries of the application logic. Its pointcut selects the asynchronous methods of the providers of `OrdersModule` whose token ends in `Repository` or `Client`, with no decorator on any of them. It is outside `RetryAspect`: a retried call is one call.
- **`ReconciliationWorker`** starts a timer when the application has started and stops it at shutdown. Its calls of `CheckoutService.complete` run under the same three aspects as those a route handler makes.
- The two annotations accept only methods that return a promise, and the application fails to start when no aspect handles them.

For one transactional method, a call of `Database.transactional()` inside the method does the same as the annotation. The aspects are used here for what the explicit calls leave open: the retry has to be outside the transaction in every method, and the statistics have to cover the repository and client methods added later.

## Run

From the repository root:

```sh
pnpm install
pnpm exec turbo run build --filter nestjs-aspect-basic-example
pnpm --filter nestjs-aspect-basic-example start
```

The Turbo build compiles `nestjs-aspect` before the example. The application listens on port 3000; `PORT` selects another port. `RECONCILE_INTERVAL_MILLISECONDS` sets the interval of the worker, 30 seconds by default.

## Try it

Place an order. The SKU selects how the inventory service behaves: for `flaky` it stores the reservation and loses its first two answers, for `offline` it never answers, for `sold-out` it refuses, and for any other SKU it answers.

```sh
curl --header "content-type: application/json" \
  --data '{"sku":"flaky","quantity":2}' \
  http://localhost:3000/orders
curl http://localhost:3000/orders
curl http://localhost:3000/orders/events
curl http://localhost:3000/statistics
```

- The order for `flaky` is confirmed after the third request of `InventoryClient.reserve`. The three requests carry one idempotency key and yield one reservation, and the statistics count one call of that method.
- An order for `offline` answers `201` with the status `pending` after three attempts. The worker tries again on every run, and the statistics count the failed calls.
- An order for `sold-out` answers `409` after one attempt, and `GET /orders` lists it as cancelled.
- `GET /orders/events` lists the events that were stored with each change.

## Files

- `src/transactional.ts` declares the `Transactional` annotation; `src/retryable.ts` declares the `Retryable` annotation and `TransientError`.
- `src/transaction.aspect.ts`, `src/retry.aspect.ts` and `src/statistics.aspect.ts` are the aspects; `src/call-statistics.ts` is the provider `StatisticsAspect` injects, and `src/statistics.controller.ts` serves it.
- `src/database.ts` is the in-memory database with transactions and conflict detection.
- `src/orders.service.ts` holds the transactional changes of an order, `src/orders.repository.ts` and `src/outbox.repository.ts` their writes.
- `src/checkout.service.ts` places an order; `src/inventory.client.ts` is the client of the inventory service, and `src/inventory.transport.ts` the in-memory service behind it.
- `src/reconciliation.worker.ts` is the timer that completes pending orders.
- `src/orders.module.ts` declares the controller and the advised providers; `src/app.module.ts` imports `AspectModule.forRoot()` first and registers the aspects.
- `src/create-app.ts` creates the Nest application on the Express adapter; `src/main.ts` starts it.
- `src/create-app.test.ts` boots the application and checks the transactions, the retries, the statistics and the worker. Run it from the repository root with `pnpm --filter nestjs-aspect-basic-example test`.
