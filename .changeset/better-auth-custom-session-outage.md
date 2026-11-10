---
"@nestjs-kit/better-auth": patch
---

The policy conformance kit accepts a 5xx for a storage outage under `customSession`, which Better Auth 1.7.8 and later report instead of a 401.
