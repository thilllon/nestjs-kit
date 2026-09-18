---
"@nestjs-kit/s3": major
---

Publish the coordinated multi-connection architecture release. S3 retains its existing alias-based API: register independent endpoints with the second argument's `alias` and inject each with `InjectS3Client(alias)`. Verify endpoint, credential and cleanup isolation across synchronous and asynchronous registrations, including coexistence with the default client. No S3 injection API rename is required.
