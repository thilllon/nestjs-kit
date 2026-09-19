# nestjs-pg-listen

## 5.0.0

### Major Changes

- 1b98662: Replace generic public MODULE_OPTIONS_TOKEN exports with namespaced getAzureStorageBlobOptionsToken(alias), getDrizzlePgOptionsToken() and getPgListenOptionsToken() helpers. The Azure helper replaces getStorageBlobOptionsToken and retains existing default and named token values. PostgreSQL helpers identify the existing registration-local builder token without introducing alias-based options tokens or changing provider visibility.

## 4.0.0

### Major Changes

- ee7c3b3: Replace package-specific injection decorators with Nest `Inject` and public token helpers. Azure and named Drizzle tokens now separate the alias with an underscore; Drizzle retains distinct database, connection and service namespaces to prevent alias collisions. Default tokens remain unchanged.

  Allow each pg-listen registration to supply a Nest LoggerService through synchronous or asynchronous configuration. The default Nest logger still follows the application's global logger, while registration-local loggers receive their own subscriber and startup-cleanup errors.

  Remove Azure service forwarding-only deleteFile, deleteFileIfExists and downloadStream methods. Use getClient().getContainerClient(container).getBlockBlobClient(blob) with the SDK delete, deleteIfExists or download method instead; SAS, listFiles and getUploadable helpers remain.

## 3.0.0

### Major Changes

- 9c4e700: Add isolated named PostgreSQL registrations with subscriber, raw connection, and service injection decorators. Each registration owns its configuration and shutdown. Keep default class injection and existing database/subscriber decorators, and normalize empty aliases to the default registration. Drizzle's service token helper now resolves the default alias to the default service class. This coordinated major release is requested by the maintainer.

  Named Drizzle tokens now use separate database, connection and service namespaces to prevent cross-role alias collisions. Replace hard-coded named token strings with the public helpers or decorators; default tokens remain compatible.

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
