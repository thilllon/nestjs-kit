---
"nestjs-pubnub": patch
---

Require the `pubnub` peer at `^13.0.3`. PubNub 13.0.3 bundles the `NodeTransportProxyConfiguration` and `DataSyncEvent` declarations, so applications compiled with `skipLibCheck: false` type-check cleanly in both ESM and CommonJS. PubNub 13.0.1 and 13.0.2 omit those types and fail strict declaration checking.
