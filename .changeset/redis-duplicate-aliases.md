---
"@nestjs-kit/redis": major
---

Rename the `isGlobal` registration extra to `global`. Two modules that register one alias now fail bootstrap before any client connects. `@nestjs/core` `^12.0.0` is now a peer dependency.
