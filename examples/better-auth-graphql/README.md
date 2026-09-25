# Better Auth on NestJS with Apollo GraphQL

A NestJS application with an Apollo GraphQL server on the Express platform that authenticates queries, mutations and subscriptions with [`nestjs-slightly-better-auth`](../../packages/nestjs-slightly-better-auth/README.md). The Express platform also serves Better Auth's HTTP routes for sign-up and sign-in, and Better Auth's in-memory adapter stores its users and sessions, so the application starts without a database or other external services.

The example shows:

- a default Better Auth instance, which declares the Express platform and the Apollo transport through `apolloTransport()` from `nestjs-slightly-better-auth/graphql`;
- public, optional and guarded queries and a mutation, with the signed-in user injected through the `@CurrentUser()` principal parameter; the `profile` query declares `@RequireAuth()`;
- a `noteAdded` subscription over graphql-ws: the client presents its session token once, in the `connection_init` payload, and the transport authenticates every operation on the connection with it;
- a named `admin` instance with its own base path, cookie prefix and user store, bound to a resolver with `@UseAuthInstance("admin")` and injected through `getBetterAuthServiceToken("admin")`;
- credentialed CORS for Better Auth's trusted origins through `betterAuthCorsOrigin()`, and Better Auth's `bearer()` plugin for the socket token.

## Run

From the repository root:

```sh
mise exec -- pnpm install
mise exec -- pnpm exec turbo run build --filter better-auth-graphql-example
mise exec -- pnpm --filter better-auth-graphql-example start
```

The Turbo build compiles `nestjs-slightly-better-auth` before the example. GraphQL over HTTP and graphql-ws share `http://localhost:3000/graphql`.

| Variable             | Default                  | Purpose                                                                                                              |
| -------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `PORT`               | `3000`                   | HTTP and graphql-ws port.                                                                                            |
| `BETTER_AUTH_URL`    | `http://localhost:$PORT` | Better Auth base URL; its origin is trusted for cookie-authenticated requests and WebSocket upgrades.                |
| `BETTER_AUTH_SECRET` | random per process       | Secret that signs cookies and tokens. Sessions survive a restart only with a fixed secret and a persistent database. |

## Try it

The `status` and `greeting` queries accept anonymous callers:

```sh
curl --header "content-type: application/json" \
  --data '{"query":"{ status greeting }"}' http://localhost:3000/graphql
```

Apollo answers a denied operation with HTTP status 200 and a GraphQL error whose `extensions` hold `code`, `statusCode` and, where applicable, `reason`. Without a session, `{ profile { email } }` fails with `UNAUTHENTICATED`. Sign up an application user, keep the session cookie in `user.txt` and the session token in `SESSION_TOKEN`, and query the profile with the cookie:

```sh
export SESSION_TOKEN=$(curl --silent --cookie-jar user.txt \
  --header "content-type: application/json" \
  --data '{"name":"Ada","email":"ada@example.com","password":"correct horse battery staple"}' \
  http://localhost:3000/api/auth/sign-up/email | jq --raw-output .token)
curl --cookie user.txt --header "content-type: application/json" \
  --data '{"query":"{ profile { email name } greeting }"}' http://localhost:3000/graphql
```

`dist/subscribe.js` subscribes to `noteAdded` over graphql-ws and prints every note, or the failure with a non-zero exit code. It reads the session token from the `SESSION_TOKEN` environment variable rather than from its arguments, which other local users can usually list. Its `--url` option defaults to `ws://localhost:$PORT/graphql`. Without a token, the subscription fails with `UNAUTHENTICATED`:

```sh
mise exec -- node examples/better-auth-graphql/dist/subscribe.js
```

In a second terminal, add a note. Better Auth's origin check applies to mutations over HTTP: a request that carries the session cookie needs a trusted `Origin` header and otherwise fails with `FORBIDDEN` and `reason: "MISSING_OR_NULL_ORIGIN"`. Browsers send the header; other clients set it explicitly:

```sh
curl --cookie user.txt --header "origin: http://localhost:3000" \
  --header "content-type: application/json" \
  --data '{"query":"mutation { addNote(text: \"Hello\") { id text author } }"}' \
  http://localhost:3000/graphql
```

The transport authenticates each operation when it starts, from the credentials of its connection, and resolves the session again every time. After sign-out, new operations on an open connection fail with `UNAUTHENTICATED`. A subscription that is already running is not authenticated again and keeps delivering notes until the client or the server ends it. `curl --header @-` reads the header from standard input, which keeps the token out of its arguments:

```sh
printf 'authorization: Bearer %s\n' "$SESSION_TOKEN" |
  curl --header @- --request POST http://localhost:3000/api/auth/sign-out
```

Operators sign up through the named instance's mount at `/api/admin-auth`. Its `admin-auth.session_token` cookie authenticates the `operator` and `operatorSessionExpiresAt` queries, and the application user's cookie does not:

```sh
curl --cookie-jar admin.txt --header "content-type: application/json" \
  --data '{"name":"Grace","email":"grace@example.com","password":"correct horse battery staple"}' \
  http://localhost:3000/api/admin-auth/sign-up/email
curl --cookie admin.txt --header "content-type: application/json" \
  --data '{"query":"{ operator { email } operatorSessionExpiresAt }"}' \
  http://localhost:3000/graphql
curl --cookie user.txt --header "content-type: application/json" \
  --data '{"query":"{ operator { email } }"}' http://localhost:3000/graphql
```

Browser clients can authenticate graphql-ws operations with the session cookie of the upgrade request instead of a token. The upgrade request must then come from one of Better Auth's trusted origins, and the client still sends an object `connection_init` payload, such as `connectionParams: {}` ([#601](https://github.com/thilllon/nestjs-kit/issues/601)).

## Files

- `src/auth.ts` creates both Better Auth instances with the `nestjs()` plugin, adds `bearer()` to the default instance and registers their types.
- `src/app.module.ts` registers the Apollo GraphQL module with graphql-ws subscriptions and the default and named instances.
- `src/account.resolver.ts` and `src/admin.resolver.ts` define the operations for each instance; `src/notes.service.ts` publishes notes to open subscriptions.
- `src/create-app.ts` creates the Nest application on the Express adapter; `src/main.ts` starts it.
- `src/client.ts` opens a graphql-ws client with the session token; `src/subscribe.ts` is its command-line entry.
- `src/create-app.test.ts` boots the application and checks HTTP operations for both instances and a subscription over graphql-ws. Run it from the repository root with `mise exec -- pnpm test examples/better-auth-graphql`.

## Deploy

Replace `memoryAdapter` with a persistent Better Auth database adapter and set `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL`. Keep distinct base paths and cookie prefixes for every instance. With `bearer({ requireSignature: true })`, Better Auth ignores tokens without the server's signature instead of looking them up; clients then send the signed token from the `set-auth-token` response header. Set `NODE_ENV=production` so that Apollo omits stack traces from error responses. `NotesService` delivers notes only to subscribers in its own process; run several processes with a shared publish-subscribe service instead. Behind a reverse proxy, configure Express `trust proxy`: the platform passes `req.ip` to Better Auth's rate limiter.
