---
"@nestjs-kit/better-auth": minor
---

Require `better-auth` 1.7.7 or newer. Releases before 1.7.7 are affected by GHSA-965c-763c-88jm, in which OAuth state can be used as a Magic Link to sign in as another user. The peer range is `>=1.7.7 <2`.
