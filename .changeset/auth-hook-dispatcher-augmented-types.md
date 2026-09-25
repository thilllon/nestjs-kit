---
"nestjs-slightly-better-auth": patch
---

Keep the package source type-valid in programs whose `Register` augmentation names an instance with plugin or required additional user fields, such as `admin()`, `organization()` and `apiKey()`. The database hook dispatchers take better-auth's own hook parameters, while hook methods keep `DatabaseHookData` with the registered instance's fields, partial update payloads, delete hooks that can only abort and nullable endpoint contexts. The API-key conformance kit's fixture permission no longer depends on the registered instance's admin statements.
