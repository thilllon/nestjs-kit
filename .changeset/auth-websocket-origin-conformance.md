---
"nestjs-slightly-better-auth": minor
---

`transportConformance` runs the WebSocket origin cases `T-ws-origin-untrusted`, `T-ws-origin-junk-token`, `T-ws-origin-dynamic-baseurl`, `T-ws-origin-forwarded-host` and `T-ws-origin-function-trusted-origins` for transports whose browser leg is a connection's handshake: a cookie handshake from an untrusted or missing `Origin` is denied on every message and at connection time, whatever token or forwarding headers it carries, and a function-valued `trustedOrigins` receives the handshake's absolute URL once per connection. Harnesses of such transports pass the new `invokeConnection` helper, and `authenticateConnection` when the app provides `WS_CONNECTION_AUTH`. The `T-csrf-*` cases apply to browser legs that follow each operation, and `T-selection` fails `expectBrowserLeg: false` for a transport that describes a browser leg.
