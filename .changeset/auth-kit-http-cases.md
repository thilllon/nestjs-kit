---
"nestjs-slightly-better-auth": minor
---

Complete the HTTP platform conformance kit. `httpPlatformConformance()` adds `H-close-keeps-hooks` and `H-proxy-untrusted-warning`. It also adds the production-mode per-IP rate-limit and Better Auth `trustedProxies` variants of `H-ip-platform`, the dynamic `allowedHosts` variant of `H-mount-custom-path`, and HTTP/2 rows for platforms that declare `capabilities.http2`. The new optional `microservice` option supplies transport options for the `NestFactory.createMicroservice()` and `Test.createNestMicroservice()` rows of `H-no-adapter`. The probe's `/probe/ip` endpoint also reports the IP Better Auth resolves without its development and test localhost fallback, and `H-ip-platform` asserts that value.
