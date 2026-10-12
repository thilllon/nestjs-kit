---
"nestjs-aspect": patch
---

Fix three weaving defects.

- A `LazyModuleLoader.load()` that an introduction collision rejects weaves the other classes of the loaded modules, so a `requiresAdvice` member of such a class no longer runs without advice. Every later `load()` reports the collision again.
- A subclass that inherits a woven member and matches no advisor runs the original function once a lazy module registers it or the `exclude` option names it, also when one of its instances was called before.
- An instance of a `perTarget` or `perClass` aspect receives the provider that the module of the aspect registers under a token, instead of the provider another module registers under the same token.
