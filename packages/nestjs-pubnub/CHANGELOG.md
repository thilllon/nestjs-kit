# nestjs-pubnub

## 5.0.1

### Patch Changes

- 89fadf4: Require the `pubnub` peer at `^13.0.3`. PubNub 13.0.3 bundles the `NodeTransportProxyConfiguration` and `DataSyncEvent` declarations, so applications compiled with `skipLibCheck: false` type-check cleanly in both ESM and CommonJS. PubNub 13.0.1 and 13.0.2 omit those types and fail strict declaration checking.

## 5.0.0

### Major Changes

- 03465d6: Access module-local configuration tokens through getCloudinaryOptionsToken, getPubNubOptionsToken and getNodemailerOptionsToken. Generated builder tokens stay private, and Cloudinary no longer exports MODULE_OPTIONS_TOKEN from its public entry point. Registration scoping, client aliases and lifecycle behavior remain unchanged.

## 4.0.0

### Major Changes

- 77a3f7c: Use Nest Inject with the public account-token helpers or NODEMAILER_TRANSPORTER instead of package-specific injection decorators. Nodemailer message delivery and verification now use the exposed transporter directly; lifecycle management remains in the service. Cloudinary account isolation, signing and upload behavior are unchanged.

## 3.0.0

### Major Changes

- 8f48f53: Support independent named PubNub clients and Cloudinary services with alias-based synchronous and asynchronous registration. Preserve default injection and isolate each named registration. Remove Cloudinary's shared raw SDK accessors; use the account-scoped upload, ping and signing methods instead.

  Cloudinary operations now require explicit registration-local credentials and reject nonempty shared SDK configuration, including CLOUDINARY_URL, CLOUDINARY_ACCOUNT_URL and CLOUDINARY_API_PROXY. Configure each account directly instead of relying on SDK-global state; endpoint and signing defaults are explicit. This prevents global OAuth, proxy or credential settings from redirecting an account-specific operation.

## 2.0.1

### Patch Changes

- - @nestjs-kit/cloudinary: refactor: flatten package source directories (#478)
  - @nestjs-kit/pubnub: refactor: flatten package source directories (#478)

## 2.0.0

### Major Changes

- 63448ab: Prepare the maintainer-requested coordinated major publication of the six existing integrations, including the current APIs, typed dual-module builds, and refreshed package documentation.

## 1.0.2

### Patch Changes

- ecfac70: Refresh published READMEs with npm version, monthly download and CI badges, and remove completed first-publication notices.

## 1.0.1

### Patch Changes

- - nestjs-azure-storage-blob: refactor: centralize package and test TypeScript settings (#440)
  - nestjs-drizzle-pg: refactor: centralize package and test TypeScript settings (#440)
  - nestjs-pg-listen: refactor: centralize package and test TypeScript settings (#440)
  - @nestjs-kit/cloudinary: refactor: centralize package and test TypeScript settings (#440)
  - @nestjs-kit/pubnub: refactor: centralize package and test TypeScript settings (#440)
  - @nestjs-kit/s3: refactor: centralize package and test TypeScript settings (#440)

## 1.0.0

### Major Changes

- - nestjs-azure-storage-blob: feat!: modernize workspace and integration packages for Node LTS (#422); build: ship all libraries as dual modules with tsdown (#433)
  - nestjs-drizzle-pg: feat!: modernize workspace and integration packages for Node LTS (#422); build: ship all libraries as dual modules with tsdown (#433)
  - nestjs-pg-listen: feat!: modernize workspace and integration packages for Node LTS (#422); feat(pg-listen): add NestJS PostgreSQL notification adapter (#424); build: ship all libraries as dual modules with tsdown (#433)
  - @nestjs-kit/cloudinary: feat!: modernize workspace and integration packages for Node LTS (#422); build: ship all libraries as dual modules with tsdown (#433)
  - @nestjs-kit/pubnub: feat!: modernize workspace and integration packages for Node LTS (#422); build: ship all libraries as dual modules with tsdown (#433)
  - @nestjs-kit/s3: feat!: modernize workspace and integration packages for Node LTS (#422); build: ship all libraries as dual modules with tsdown (#433)
- a6b8305: Modernize all integrations for Node.js 24 and NestJS 12 with separate ESM and CommonJS builds, matching declarations, updated SDK dependencies, and corrected resource lifecycles. Start the new @nestjs-kit packages and nestjs-pg-listen at 1.0.0 while preserving the existing Azure and Drizzle package identities. See each package README for API and runtime requirements.
