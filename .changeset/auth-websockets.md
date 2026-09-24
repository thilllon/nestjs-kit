---
"nestjs-slightly-better-auth": minor
---

Add the `./websockets` entry point for Socket.IO and raw `ws` gateways.

Register `socketIoTransport()` or `wsTransport()` in the module's `transports` and decorate gateways with `@UseBetterAuth()`; startup reports message handlers without guard and scope coverage as `GATEWAY_UNGUARDED`. Message handlers use the existing access, session and authorization decorators. Socket.IO reads the handshake headers and maps a string `auth.token` to a bearer credential; raw `ws` reads the upgrade request recorded by `withUpgradeRequest(WsAdapter)`. A `credentials(client)` mapper can replace those credentials, while the browser-origin check keeps using the original handshake. Malformed credentials fail with a 401 `MALFORMED_CREDENTIALS` that does not quote the rejected value.

`WsConnectionAuth` (also injectable as `WS_CONNECTION_AUTH`) authenticates connections through `socketIoMiddleware()` or `authenticate()`, and `wsCloseCodeFor()` maps failures to close codes 4401, 4403 and 4429. `principalTtlMs` (default 0) reuses a successful authentication on the same connection. The entry requires the optional peer `@nestjs/websockets` 12 and `@nestjs/platform-socket.io` or `@nestjs/platform-ws`.
