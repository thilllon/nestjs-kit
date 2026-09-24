# Better Auth on NestJS with Express

A NestJS application on the Express platform that authenticates requests with [`nestjs-slightly-better-auth`](../../packages/nestjs-slightly-better-auth/README.md). Better Auth's in-memory adapter stores its users and sessions, so the application starts without a database or other external services.

The example shows:

- a default Better Auth instance, which declares the Express platform and registers the global guard;
- a named `admin` instance with its own base path, cookie prefix and user store, bound to a controller with `@UseAuthInstance("admin")` and injected through `getBetterAuthServiceToken("admin")`;
- public, optional and guarded routes, with the signed-in user injected through the `@CurrentUser()` principal parameter;
- credentialed CORS for Better Auth's trusted origins through `betterAuthCorsOrigin()`.

## Run

From the repository root:

```sh
mise exec -- pnpm install
mise exec -- pnpm exec turbo run build --filter better-auth-express-example
mise exec -- pnpm --filter better-auth-express-example start
```

The Turbo build compiles `nestjs-slightly-better-auth` before the example. The application listens on port 3000.

| Variable             | Default                 | Purpose                                                                         |
| -------------------- | ----------------------- | ------------------------------------------------------------------------------- |
| `PORT`               | `3000`                  | HTTP port.                                                                      |
| `BETTER_AUTH_URL`    | `http://localhost:3000` | Better Auth base URL; its origin is trusted for cookie-authenticated requests.  |
| `BETTER_AUTH_SECRET` | random per process      | Secret that signs cookies and tokens. Set it to keep sessions valid on restart. |

## Try it

Sign up an application user and call the guarded route with the session cookie:

```sh
curl --cookie-jar user.txt --header "content-type: application/json" \
  --data '{"name":"Ada","email":"ada@example.com","password":"correct horse battery staple"}' \
  http://localhost:3000/api/auth/sign-up/email
curl --cookie user.txt http://localhost:3000/account/profile
```

`GET /account/profile` answers `401` without the session cookie. `GET /account/greeting` accepts anonymous and signed-in callers, and `GET /account/status` is public.

Operators sign up through the named instance's mount at `/api/admin-auth`. Its `admin-auth.session_token` cookie authenticates the `/admin` routes, and the application user's cookie does not:

```sh
curl --cookie-jar admin.txt --header "content-type: application/json" \
  --data '{"name":"Grace","email":"grace@example.com","password":"correct horse battery staple"}' \
  http://localhost:3000/api/admin-auth/sign-up/email
curl --cookie admin.txt http://localhost:3000/admin/me
curl --cookie user.txt http://localhost:3000/admin/me
```

Better Auth rejects a cookie-carrying request to an unsafe endpoint without a trusted `Origin` header with `403 MISSING_OR_NULL_ORIGIN`. Browsers send the header; other clients set it explicitly:

```sh
curl --cookie user.txt --header "origin: http://localhost:3000" \
  --request POST http://localhost:3000/api/auth/sign-out
```

## Files

- `src/auth.ts` creates both Better Auth instances with the `nestjs()` plugin and registers their types.
- `src/app.module.ts` registers the default and named instances.
- `src/account.controller.ts` and `src/admin.controller.ts` define the routes for each instance.
- `src/create-app.ts` creates the Nest application on the Express adapter; `src/main.ts` starts it.
- `src/create-app.test.ts` boots the application and checks both instances. Run it from the repository root with `mise exec -- pnpm test examples/better-auth-express`.

## Deploy

Replace `memoryAdapter` with a persistent Better Auth database adapter and set `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL`. Keep distinct base paths and cookie prefixes for every instance. Behind a reverse proxy, configure Express `trust proxy`: the platform passes `req.ip` to Better Auth's rate limiter.
