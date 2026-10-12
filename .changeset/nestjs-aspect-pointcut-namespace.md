---
"nestjs-aspect": patch
---

Export the pointcut designator namespace as `Pointcut` in place of `P`. The name is both the namespace and the `Pointcut<Shape>` type; import it with an alias, such as `import { Pointcut as P } from "nestjs-aspect"`, to keep `P.method(...)` call sites.
