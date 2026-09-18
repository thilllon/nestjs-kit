---
"@nestjs-kit/pubnub": major
"@nestjs-kit/cloudinary": major
---

Support independent named PubNub clients and Cloudinary services with alias-based synchronous and asynchronous registration. Preserve default injection and isolate each named registration. Remove Cloudinary's shared raw SDK accessors; use the account-scoped upload, ping and signing methods instead.

Cloudinary operations now require explicit registration-local credentials and reject nonempty shared SDK configuration, including CLOUDINARY_URL, CLOUDINARY_ACCOUNT_URL and CLOUDINARY_API_PROXY. Configure each account directly instead of relying on SDK-global state; endpoint and signing defaults are explicit. This prevents global OAuth, proxy or credential settings from redirecting an account-specific operation.
