# Better Auth on NestJS microservices over TCP

A hybrid NestJS application whose TCP microservice authenticates every message with [`nestjs-slightly-better-auth`](../../packages/nestjs-slightly-better-auth/README.md). The Express platform serves Better Auth's HTTP routes for sign-up and sign-in, and Better Auth's in-memory adapter stores its users and sessions, so the application starts without a database, a message broker or other external services.

The example shows:

- a default Better Auth instance, which declares the Express platform and the RPC transport through `rpcTransport()`;
- message controllers decorated with `@UseBetterAuth()`, the coverage that startup verifies in a hybrid application, whose public, optional and guarded handlers read the signed-in user through the `@CurrentUser()` principal parameter;
- the TCP credential carrier: a client sends `{ auth: { authorization: "Bearer <token>" } }` in the message payload, and every message is authenticated separately;
- a named `admin` instance with its own base path, cookie prefix and user store, bound to a controller with `@UseAuthInstance("admin")` and injected through `getBetterAuthServiceToken("admin")`;
- Better Auth's `bearer()` plugin, so clients authenticate with the session token.

## Run

From the repository root:

```sh
pnpm install
pnpm exec turbo run build --filter better-auth-rpc-example
pnpm --filter better-auth-rpc-example start
```

The Turbo build compiles `nestjs-slightly-better-auth` before the example. The HTTP server listens on port 3000 and the TCP microservice on `127.0.0.1:4000`.

| Variable             | Default                  | Purpose                                                                                                              |
| -------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `PORT`               | `3000`                   | HTTP port.                                                                                                           |
| `RPC_HOST`           | `127.0.0.1`              | TCP microservice host.                                                                                               |
| `RPC_PORT`           | `4000`                   | TCP microservice port.                                                                                               |
| `BETTER_AUTH_URL`    | `http://localhost:$PORT` | Better Auth base URL. RPC messages have no HTTP host, so the base URL is static.                                     |
| `BETTER_AUTH_SECRET` | random per process       | Secret that signs cookies and tokens. Sessions survive a restart only with a fixed secret and a persistent database. |

## Try it

`dist/call.js` sends one message through a Nest TCP client and prints the reply, or the failure with a non-zero exit code. It reads the session token from the `SESSION_TOKEN` environment variable rather than from its arguments, which other local users can usually list. Its options are `--host` and `--port`, which default to `RPC_HOST` and `RPC_PORT`.

`account.status` and `account.greeting` accept messages without credentials, and `account.profile` answers `401`:

```sh
node examples/better-auth-rpc/dist/call.js account.status
node examples/better-auth-rpc/dist/call.js account.greeting
node examples/better-auth-rpc/dist/call.js account.profile
```

Sign up an application user over HTTP and keep the session token from the response body in `SESSION_TOKEN`; the client sends it with each message:

```sh
export SESSION_TOKEN=$(curl --silent --header "content-type: application/json" \
  --data '{"name":"Ada","email":"ada@example.com","password":"correct horse battery staple"}' \
  http://localhost:3000/api/auth/sign-up/email | jq --raw-output .token)
node examples/better-auth-rpc/dist/call.js account.profile
```

Operators sign up through the named instance's mount at `/api/admin-auth`. Their token authenticates the `admin.*` messages, and the application user's token does not:

```sh
OPERATOR_TOKEN=$(curl --silent --header "content-type: application/json" \
  --data '{"name":"Grace","email":"grace@example.com","password":"correct horse battery staple"}' \
  http://localhost:3000/api/admin-auth/sign-up/email | jq --raw-output .token)
SESSION_TOKEN="$OPERATOR_TOKEN" node examples/better-auth-rpc/dist/call.js admin.me
node examples/better-auth-rpc/dist/call.js admin.me
```

Each message resolves the session again. After sign-out, the same token answers `401`. `curl --header @-` reads the header from standard input, which keeps the token out of its arguments:

```sh
printf 'authorization: Bearer %s\n' "$SESSION_TOKEN" |
  curl --header @- --request POST http://localhost:3000/api/auth/sign-out
node examples/better-auth-rpc/dist/call.js account.profile
```

## Files

- `src/auth.ts` creates both Better Auth instances with the `bearer()` and `nestjs()` plugins and registers their types.
- `src/app.module.ts` registers the default and named instances with the Express platform and the RPC transport.
- `src/account.controller.ts` and `src/admin.controller.ts` define the message handlers for each instance.
- `src/create-app.ts` creates the Nest application on the Express adapter and connects the TCP microservice; `src/main.ts` starts both.
- `src/client.ts` sends messages with the token in the payload envelope; `src/call.ts` is its command-line entry.
- `src/create-app.test.ts` boots the application, connects a TCP client and checks both instances. Run it from the repository root with `pnpm test examples/better-auth-rpc`.

## Deploy

Replace `memoryAdapter` with a persistent Better Auth database adapter and set `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL`. Keep distinct base paths and cookie prefixes for every instance. The TCP transport carries tokens in plain text; keep it on a private network or enable Nest's TLS options. With `bearer({ requireSignature: true })`, Better Auth ignores tokens without the server's signature instead of looking them up; clients then send the signed token from the `set-auth-token` response header.

Nest applies global guards to a connected microservice only with `connectMicroservice(options, { inheritAppConfig: true })`. This example applies `@UseBetterAuth()` to its message controllers instead, so startup fails with `RPC_HANDLER_UNGUARDED` when a message handler lacks authentication. To rely on the inherited global guard, pass `inheritAppConfig: true` to every `connectMicroservice()` call and to `rpcTransport()`.
