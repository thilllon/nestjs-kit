---
"nestjs-slightly-better-auth": minor
---

`policyConformance` accepts `deliveries`, a list of `PolicyDelivery` adapters that route its transport-specific rows through real transports. For each delivery, the kit runs `Z-admin-rejects-api-key-session`, `Z-org-ref-types` with junk inputs in the transport's payload, the API-key session setup of `Z-apikey-quota-per-request` and, for connection deliveries with a principal TTL, `Z-admin-banned` on one connection. It also accepts `variant(overrides)`, which builds the instances the kit needs in another configuration on the storage under test. The default is `createConformanceAuth(overrides)`. `./testing/conformance` exports the `PolicyDelivery` and `PolicyDeliveryConnection` types.
