---
"@nestjs-kit/s3": major
---

Replace package-specific injection decorators with Nest's `Inject` and exported client/options constants and token helpers. Use `@Inject(MODULE_CLIENT_TOKEN)` for the default client and `@Inject(getClientToken("primary"))` for a named client.

Named client and options tokens now insert an underscore before the alias, while unnamed tokens remain unchanged. Update any hard-coded named provider tokens to the helper-generated form.
