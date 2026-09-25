---
"nestjs-slightly-better-auth": minor
---

Add `createTrustingHttpAdapter` and `http2.createTrustingHttpAdapter` to the HTTP platform conformance kit options, so
platforms that fix proxy trust at adapter construction, such as Fastify, run the trusted-hop rows of `H-ip-platform`,
`H-url-trust-proxy` and `H-proxy-untrusted-warning`. The trusted-hop rows also run over HTTP/2, and the trusted-hop row
of `H-proxy-untrusted-warning` runs on platforms without `proxyTrust()`.
