---
"nestjs-azure-storage-blob": major
"nestjs-drizzle-pg": major
"nestjs-pg-listen": major
---

Replace generic public MODULE_OPTIONS_TOKEN exports with namespaced getAzureStorageBlobOptionsToken(alias), getDrizzlePgOptionsToken() and getPgListenOptionsToken() helpers. The Azure helper replaces getStorageBlobOptionsToken and retains existing default and named token values. PostgreSQL helpers identify the existing registration-local builder token without introducing alias-based options tokens or changing provider visibility.
