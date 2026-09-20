---
reviewer: SEC
round: 7
reviewed: design-v7.md
initial_verdict: reject
verdict: approve
blockers: 0
majors: 0
minors: 0
prior_unresolved: []
---

# Round 7 review: SEC

Reviewed the round-6 security dispositions and the affected scope, transport,
origin, cookie-forwarding and conformance contracts. This is a design review,
not a security approval of an implementation: the package still exports nothing.

Initial reviewed document SHA-256:
`88bf9b74641eafaf138b07b5b52fc056096a6335a71864aa1fdbb88389bb45ea`.

## Prior findings

| Finding   | Disposition        | Evidence                                                                                                                                                                                                                                                                                                                                                                                       |
| --------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SEC-r6-01 | Resolved in design | Sections 7.5 and 7.10 remove guard execution as an origin proof. Cookie-bearing safe legs obtain an advisory verdict; failure permits an ordinary safe read but never the later caller-session call. Section 14.5 requires both required/optional GET proxies and trusted/untrusted origins.                                                                                                   |
| SEC-r6-02 | Resolved in design | Sections 4.2 and 7.5 require a nonthrowing structural envelope and lazy credential/browser/cookie capabilities. Public scope creation performs no authentication extraction. Invalid direct calls still fail before endpoint execution; no unscoped fallback is allowed. Sections 7.8 and 9.2 add authenticated inherited-read liveness validation through `InvocationLineage.assertReadable`. |
| SEC-r6-03 | Resolved in design | B16 and `LIB-coverage-rule` distinguish actual global-guard reach from explicit guard-plus-interceptor reach. Disabling global scope warns but does not fabricate an explicit interceptor.                                                                                                                                                                                                     |

The implementation must prove these properties with real handlers. In particular,
a JavaScript object spread over a lazy scope would evaluate getters and violate
the public-handler contract; the written contract alone does not prevent that bug.

## SEC-r7-01 — Major: cookie-free safe-method login proxies bypass form-CSRF

**Affected contracts:** Sections 7.1, 7.5, 7.10, 9.1, 10.2 and the
`T-csrf-login-proxy` / `LIB-public-direct-call` acceptance cases.

Consider a public `GET /login` handler declaring `@ForwardAuthCookies()` and
calling `auth.api.signInEmail` with query-derived credentials. The handler need
not already possess a session cookie: logging the victim into an attacker-owned
account is the attack.

1. HTTP marks this browser leg `enforce: false` because the method is GET.
2. Section 7.10 item 2 gates both cookie and form modes on that flag. The new
   advisory path requires an inbound cookie, so a cookie-free navigation does no
   origin work either.
3. Better Auth server API calls do not run the router's form-CSRF middleware.
4. The caller-session bridge checks an existing session cookie, which this call
   does not have. It therefore cannot stop the new session from being created.
5. The forwarding bridge explicitly accepts credential-free login calls and
   appends their `Set-Cookie` headers to the browser response.

A cross-site navigation can consequently set the victim's browser session to an
attacker-controlled account. A GraphQL HTTP query that forwards authentication
cookies has the same contract gap when exposed through a navigable GET endpoint.
Recommending POST does not enforce the safety of the allowed forwarding API.

### Current SDK evidence

Reproduced locally against the published `better-auth@1.7.5` package, Node
24.21.0, a memory adapter, explicit `disableOriginCheck: false` and
`disableCSRFCheck: false`. The probe used only generated test accounts and a local
in-process handler. No remote account or production credentials were used.

The source checkout was tag v1.7.5, commit
`5468e6bfcdff799848537cf5ad06ebab15aad9dd`. The router/server-call split is visible
in [Better Auth's origin middleware](https://github.com/better-auth/better-auth/blob/5468e6bfcdff799848537cf5ad06ebab15aad9dd/packages/better-auth/src/api/middlewares/origin-check.ts)
and [API router](https://github.com/better-auth/better-auth/blob/5468e6bfcdff799848537cf5ad06ebab15aad9dd/packages/better-auth/src/api/index.ts).

Probe command, run from the monorepo:

```sh
mise exec -- pnpm exec tsx /private/tmp/nsba-implementation/probes/cookieless-login-proxy.mts
```

Observed result:

```json
{
  "sdk": "1.7.5",
  "inboundCookie": false,
  "browserFetchSite": "cross-site",
  "nativeRouterStatus": 403,
  "serverApiCreatesSessionCookie": true
}
```

The request also carried `Sec-Fetch-Mode: navigate` and
`Sec-Fetch-Dest: document`. Native `POST /api/auth/sign-in/email` rejected it;
the direct server call using the same headers created a session cookie. This
reproduces the SDK prerequisite, not a running adapter: the adapter is not yet
implemented. Steps 1–5 above show why the current design would forward the cookie.

### Required correction and acceptance

Make form mode enforcing whenever a handler declares direct-cookie forwarding,
regardless of HTTP method or GraphQL operation type. Method-based enforcement
and advisory safe-leg verdicts then apply only to cookie mode. Keep the existing
form rule's headerless non-browser allowance and explicit `@SkipOriginCheck()`
escape; do not invent a second, weaker check inside the plugin.

Require real Express/Fastify public GET login proxies and GraphQL query forwarding
fixtures. A cookie-free cross-site navigation must be rejected before the server
API executes, with no session write or response cookie; trusted origins must
work. Include cookie-bearing safe forwarding, explicit opt-out, ordinary safe
non-forwarding reads, and the documented headerless non-browser case. Keep the
existing unsafe login-proxy cases.

**Verdict:** reject until SEC-r7-01 is reconciled across the guard algorithm,
origin rules, public API comments, ADRs and regression requirements.

## Bounded re-review of the amended design

Reviewed snapshot:
`c0cebe751426440ee8ede6bbf8fed3fb1d8b4a2fc4282b548a5696f139004308`.
The initial rejection and reproducer above remain part of the review history.

**SEC-r7-01 is resolved in the operative design.** Section 7.1 performs the
form check before public or inherited forwarding can return. Section 7.10 makes
form mode enforcing independently of `browser.enforce`; cookie mode retains
advisory safe-method behavior. B16 no longer treats inherited form access as
sufficient coverage. The API comments and section 14.5 require cookie-free GET,
query and nested-forwarding regressions with separate API-call, session-write
and response-cookie counters. Trusted navigation flags cannot override a
cross-site navigation denial. Headerless non-browser behavior and explicit
opt-outs remain visible, with no new implicit bypass.

The inherited-form correction does not resolve or overwrite the enclosing
principal. It adds only the origin check and reachable-guard requirement.
Non-forwarding inherited/public paths retain their no-authentication-I/O rules.
The three round-6 closures above remain intact.

The U10 and ADR-55/56 summary wording and the short GraphQL inherited-flow
description still need editorial alignment with the operative flow; the author
is correcting those references. They do not change the already explicit guard
algorithm, B16, origin rule or required tests. The final document hash will be
recorded after that narrow alignment.

**Current verdict: approve the reviewed security design.** No authentication
implementation or adapter E2E run is claimed. The real integration regressions
remain mandatory before a release; this verdict does not replace their evidence.

### Final snapshot confirmation

The final document SHA-256 is
`a653719b8a48ff049b9c47ef9cf9a03d845948dab0314e083ee350041706175b`.
U10, the GraphQL inherited-field paragraph and ADR-55/56 now state the same
form-before-inherited-return rule as the reviewed algorithm. The editorial
observation is closed. The security design approval carries forward to this
snapshot; no open SEC findings remain from this round.
