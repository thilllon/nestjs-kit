---
"nestjs-slightly-better-auth": minor
---

Complete the principal-source conformance kit with the unit-specific cases of design v7 §14.1: `S-apikey-results`, `S-apikey-outage`, `S-apikey-write-outage` and `S-apikey-org-key` for API-key sources, `S-short-circuit-session` and the cookie-bridge cases `S-bridge-third-party-signup` and `S-bridge-foreign-credentials` for session-backed sources, `S-jwt-claims` for sources of the `jwt` plugin, and `S-dynamic-base-url` and `S-log-redaction` for every source. `principalSourceConformance()` passes the case's instance to `credentials.valid(auth)` and `credentials.rateLimited(auth)`, and accepts `variant()`, `credentials.apiKey()`, `credentials.organizationKey()` and an `http` platform harness. A case that does not apply to the source is skipped with the reason.
