# Better Auth on NestJS with Socket.IO

A NestJS application with Socket.IO gateways that authenticates connections and messages with [`nestjs-slightly-better-auth`](../../packages/nestjs-slightly-better-auth/README.md). The Express platform serves Better Auth's HTTP routes for sign-up and sign-in, and Better Auth's in-memory adapter stores its users and sessions, so the application starts without a database or other external services.

The example shows:

- a default Better Auth instance, which declares the Express platform and the Socket.IO transport through `socketIoTransport()`;
- gateways decorated with `@UseBetterAuth()`, whose public, optional and guarded messages read the signed-in user through the `@CurrentUser()` principal parameter;
- connection authentication through `WS_CONNECTION_AUTH`: the default namespace admits guests and rejects malformed credentials at the handshake, and the `/admin` namespace requires a session of the named instance;
- a named `admin` instance with its own base path, cookie prefix and user store, bound to a gateway with `@UseAuthInstance("admin")` and injected through `getBetterAuthServiceToken("admin")`;
- Better Auth's `bearer()` plugin, so clients authenticate with the session token in the handshake's `auth.token`.

## Run

From the repository root:

```sh
pnpm install
pnpm exec turbo run build --filter better-auth-websockets-example
pnpm --filter better-auth-websockets-example start
```

The Turbo build compiles `nestjs-slightly-better-auth` before the example. HTTP and Socket.IO share port 3000.

| Variable             | Default                  | Purpose                                                                                                              |
| -------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `PORT`               | `3000`                   | HTTP and Socket.IO port.                                                                                             |
| `BETTER_AUTH_URL`    | `http://localhost:$PORT` | Better Auth base URL; its origin is trusted for cookie-authenticated requests and handshakes.                        |
| `BETTER_AUTH_SECRET` | random per process       | Secret that signs cookies and tokens. Sessions survive a restart only with a fixed secret and a persistent database. |

## Try it

`dist/call.js` connects to a namespace, emits one event and prints the acknowledgement, or the failure with a non-zero exit code. It reads the session token from the `SESSION_TOKEN` environment variable rather than from its arguments, which other local users can usually list. Its options are `--namespace` (default `/`) and `--url` (default `http://localhost:$PORT`).

Guests connect to the default namespace. The `status` and `greeting` messages accept them, and `profile` answers `401`:

```sh
node examples/better-auth-websockets/dist/call.js status
node examples/better-auth-websockets/dist/call.js greeting
node examples/better-auth-websockets/dist/call.js profile
```

Sign up an application user and keep the session token from the response body in `SESSION_TOKEN`; the client sends it with the handshake:

```sh
export SESSION_TOKEN=$(curl --silent --header "content-type: application/json" \
  --data '{"name":"Ada","email":"ada@example.com","password":"correct horse battery staple"}' \
  http://localhost:3000/api/auth/sign-up/email | jq --raw-output .token)
node examples/better-auth-websockets/dist/call.js profile
```

Operators sign up through the named instance's mount at `/api/admin-auth`. The `/admin` namespace rejects a handshake without an operator session, including one with the application user's token, with a `401` `connect_error`:

```sh
OPERATOR_TOKEN=$(curl --silent --header "content-type: application/json" \
  --data '{"name":"Grace","email":"grace@example.com","password":"correct horse battery staple"}' \
  http://localhost:3000/api/admin-auth/sign-up/email | jq --raw-output .token)
SESSION_TOKEN="$OPERATOR_TOKEN" node examples/better-auth-websockets/dist/call.js me --namespace admin
node examples/better-auth-websockets/dist/call.js me --namespace admin
```

The transport resolves the session again for every message, so signing out also ends access on connections that stay open. After sign-out, `profile` answers `401` for the same token. `curl --header @-` reads the header from standard input, which keeps the token out of its arguments:

```sh
printf 'authorization: Bearer %s\n' "$SESSION_TOKEN" |
  curl --header @- --request POST http://localhost:3000/api/auth/sign-out
node examples/better-auth-websockets/dist/call.js profile
```

Browsers can authenticate with the session cookie instead of a token. The handshake must then come from one of Better Auth's trusted origins; otherwise the connection fails with `403`.

## Files

- `src/auth.ts` creates both Better Auth instances with the `bearer()` and `nestjs()` plugins and registers their types.
- `src/app.module.ts` registers the default and named instances with the Express platform and the Socket.IO transport.
- `src/account.gateway.ts` and `src/admin.gateway.ts` define the default and `/admin` namespaces and their connection middleware.
- `src/create-app.ts` creates the Nest application on the Express adapter with Nest's Socket.IO adapter; `src/main.ts` starts it.
- `src/client.ts` connects and sends messages with `socket.io-client`; `src/call.ts` is its command-line entry.
- `src/create-app.test.ts` boots the application and checks both namespaces. Run it from the repository root with `pnpm test examples/better-auth-websockets`.

## Deploy

Replace `memoryAdapter` with a persistent Better Auth database adapter and set `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL`. Keep distinct base paths and cookie prefixes for every instance. With `bearer({ requireSignature: true })`, Better Auth ignores tokens without the server's signature instead of looking them up; clients then send the signed token from the `set-auth-token` response header. Browser clients served from another origin also need the `cors` option of `@WebSocketGateway()`, which applies to Socket.IO's HTTP long-polling requests.
