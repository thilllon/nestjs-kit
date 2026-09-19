# @nestjs-kit/s3

## 6.0.0

### Major Changes

- 75a19ac: Replace package-specific injection decorators with Nest's `Inject` and exported client/options constants and token helpers. Use `@Inject(MODULE_CLIENT_TOKEN)` for the default client and `@Inject(getClientToken("primary"))` for a named client.

  Named client and options tokens now insert an underscore before the alias, while unnamed tokens remain unchanged. Update any hard-coded named provider tokens to the helper-generated form.

## 5.0.0

### Major Changes

- 1a36b3b: Publish the coordinated multi-connection architecture release. S3 retains its existing alias-based API: register independent endpoints with the second argument's `alias` and inject each with `InjectS3Client(alias)`. Verify endpoint, credential and cleanup isolation across synchronous and asynchronous registrations, including coexistence with the default client. No S3 injection API rename is required.

## 4.0.0

### Major Changes

- 63448ab: Prepare the maintainer-requested coordinated major publication of the six existing integrations, including the current APIs, typed dual-module builds, and refreshed package documentation.

## 3.0.0

### Major Changes

- - @nestjs-kit/s3: refactor(s3)!: remove remaining AWS-prefixed API names (#450)

## 2.0.0

### Major Changes

- - @nestjs-kit/s3: feat(s3)!: rename module and suggest compatible region values (#445)

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
