---
"@nestjs-kit/redis": major
---

Rename the `isGlobal` registration extra to `global`. Two modules that register one alias now fail bootstrap before any client connects, and a registration that fails during bootstrap disconnects the clients other registrations already connected. `@nestjs/core` `^12.0.0` is now a peer dependency.
