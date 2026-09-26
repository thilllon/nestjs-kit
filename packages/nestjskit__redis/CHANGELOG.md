# @nestjs-kit/redis

## 2.0.0

### Major Changes

- bcf37d8: Rename the `isGlobal` registration extra to `global`. Two modules that register one alias now fail bootstrap before any client connects. `@nestjs/core` `^12.0.0` is now a peer dependency.

## 1.0.0

### Major Changes

- 34d2e54: Add a client-agnostic Redis module: register `connect` and `disconnect` functions for any client library, inject the native client per alias, and close it on application shutdown.
