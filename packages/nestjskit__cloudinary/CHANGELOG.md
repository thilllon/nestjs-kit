# @nestjs-kit/cloudinary

## 3.0.0

### Major Changes

- - @nestjs-kit/cloudinary: refactor(cloudinary)!: remove local Sharp preprocessing (#473)

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
