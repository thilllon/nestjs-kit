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
mise exec -- pnpm install
mise exec -- pnpm exec turbo run build --filter better-auth-websockets-example
mise exec -- pnpm --filter better-auth-websockets-example start
```

The Turbo build compiles `nestjs-slightly-better-auth` before the example. HTTP and Socket.IO share port 3000.

| Variable             | Default                 | Purpose                                                                                                              |
| -------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `PORT`               | `3000`                  | HTTP and Socket.IO port.                                                                                             |
| `BETTER_AUTH_URL`    | `http://localhost:3000` | Better Auth base URL; its origin is trusted for cookie-authenticated requests and handshakes.                        |
| `BETTER_AUTH_SECRET` | random per process      | Secret that signs cookies and tokens. Sessions survive a restart only with a fixed secret and a persistent database. |

## Try it

`dist/call.js` connects to a namespace, emits one event and prints the acknowledgement, or the failure with a non-zero exit code. Its options are `--namespace` (default `/`), `--token` and `--url` (default `http://localhost:3000`).

Guests connect to the default namespace. The `status` and `greeting` messages accept them, and `profile` answers `401`:

```sh
mise exec -- node examples/better-auth-websockets/dist/call.js status
mise exec -- node examples/better-auth-websockets/dist/call.js greeting
mise exec -- node examples/better-auth-websockets/dist/call.js profile
```

Sign up an application user, keep the session token from the response body, and send it with the handshake:

```sh
TOKEN=$(curl --silent --header "content-type: application/json" \
  --data '{"name":"Ada","email":"ada@example.com","password":"correct horse battery staple"}' \
  http://localhost:3000/api/auth/sign-up/email | jq --raw-output .token)
mise exec -- node examples/better-auth-websockets/dist/call.js profile --token "$TOKEN"
```

The transport resolves the session again for every message, so signing out also ends access on connections that stay open. After sign-out, `profile` answers `401` for the same token:

```sh
curl --header "authorization: Bearer $TOKEN" --request POST \
  http://localhost:3000/api/auth/sign-out
mise exec -- node examples/better-auth-websockets/dist/call.js profile --token "$TOKEN"
```

Operators sign up through the named instance's mount at `/api/admin-auth`. The `/admin` namespace rejects handshakes without an operator session with a `401` `connect_error`, including the application user's token:

```sh
OPERATOR_TOKEN=$(curl --silent --header "content-type: application/json" \
  --data '{"name":"Grace","email":"grace@example.com","password":"correct horse battery staple"}' \
  http://localhost:3000/api/admin-auth/sign-up/email | jq --raw-output .token)
mise exec -- node examples/better-auth-websockets/dist/call.js me --namespace admin --token "$OPERATOR_TOKEN"
mise exec -- node examples/better-auth-websockets/dist/call.js me --namespace admin --token "$TOKEN"
```

Browsers can authenticate with the session cookie instead of a token. The handshake must then come from one of Better Auth's trusted origins; otherwise the connection fails with `403`.

## Files

- `src/auth.ts` creates both Better Auth instances with the `bearer()` and `nestjs()` plugins and registers their types.
- `src/app.module.ts` registers the default and named instances with the Express platform and the Socket.IO transport.
- `src/account.gateway.ts` and `src/admin.gateway.ts` define the default and `/admin` namespaces and their connection middleware.
- `src/create-app.ts` creates the Nest application on the Express adapter with Nest's Socket.IO adapter; `src/main.ts` starts it.
- `src/client.ts` connects and sends messages with `socket.io-client`; `src/call.ts` is its command-line entry.
- `src/create-app.test.ts` boots the application and checks both namespaces. Run it from the repository root with `mise exec -- pnpm test examples/better-auth-websockets`.

## Deploy

Replace `memoryAdapter` with a persistent Better Auth database adapter and set `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL`. Keep distinct base paths and cookie prefixes for every instance. With `bearer({ requireSignature: true })`, Better Auth ignores tokens without the server's signature instead of looking them up; clients then send the signed token from the `set-auth-token` response header. Browser clients served from another origin also need the `cors` option of `@WebSocketGateway()`, which applies to Socket.IO's HTTP long-polling requests.
