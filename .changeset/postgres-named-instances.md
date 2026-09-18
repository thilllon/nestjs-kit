---
"nestjs-pg-listen": major
"nestjs-drizzle-pg": major
---

Add isolated named PostgreSQL registrations with subscriber, raw connection, and service injection decorators. Each registration owns its configuration and shutdown. Keep default class injection and existing database/subscriber decorators, and normalize empty aliases to the default registration. Drizzle's service token helper now resolves the default alias to the default service class. This coordinated major release is requested by the maintainer.

Named Drizzle tokens now use separate database, connection and service namespaces to prevent cross-role alias collisions. Replace hard-coded named token strings with the public helpers or decorators; default tokens remain compatible.
