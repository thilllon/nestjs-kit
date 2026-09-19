---
"nestjs-azure-storage-blob": major
"nestjs-drizzle-pg": major
"nestjs-pg-listen": major
---

Replace package-specific injection decorators with Nest `Inject` and public token helpers. Azure and named Drizzle tokens now separate the alias with an underscore; Drizzle retains distinct database, connection and service namespaces to prevent alias collisions. Default tokens remain unchanged.

Allow each pg-listen registration to supply a Nest LoggerService through synchronous or asynchronous configuration. The default Nest logger still follows the application's global logger, while registration-local loggers receive their own subscriber and startup-cleanup errors.
