---
"nestjs-slightly-better-auth": patch
---

Align app-surface origin checks with Better Auth's router and with in-band credentials. A function-valued `trustedOrigins` option is evaluated per request only, as the router does, so its no-request result no longer widens the origins that cookie-mode app routes, GraphQL mutations and WebSocket legs trust. A guarded safe cookie request with `Sec-Fetch-Site: same-origin` and neither `Origin` nor `Referer` (for example under `Referrer-Policy: no-referrer`) keeps a passing advisory verdict, so its caller-session `auth.api` calls succeed. A session cookie that graphql-ws connection parameters or a WebSocket `credentials` mapping supply no longer triggers the caller-session check. `createConformanceAuth()` also forces `advanced.disableCSRFCheck: false`.
