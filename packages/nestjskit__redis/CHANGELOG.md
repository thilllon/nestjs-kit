# @nestjs-kit/redis

## 1.0.0

### Major Changes

- 34d2e54: Add a client-agnostic Redis module: register `connect` and `disconnect` functions for any client library, inject the native client per alias, and close it on application shutdown.
