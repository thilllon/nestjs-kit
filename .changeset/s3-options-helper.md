---
"@nestjs-kit/s3": major
---

Expose registration options through getS3OptionsToken(alias) instead of MODULE_OPTIONS_TOKEN or the generic getOptionsToken helper. Providers and the service constructor use the same namespaced helper; existing token values and named/default registration isolation remain unchanged.
