# Migrating to NestJS Kit

## Runtime and major versions

All libraries require Node.js 24 or newer and NestJS 12. Repository development requires Node.js 24.11 or newer for the build tools; mise selects the current LTS. Libraries provide both ESM and CommonJS entry points with matching TypeScript declarations.

The coordinated modernization release prepares `nestjs-azure-storage-blob@1.0.0`, `nestjs-drizzle-pg@2.0.0`, and `1.0.0` for each new `@nestjs-kit/*` package and `nestjs-pg-listen`. These are repository release versions; npm availability depends on completion of the owner’s publishing setup.

## Package names and directories

| Previous name                    | New npm name             | Repository directory                 |
| -------------------------------- | ------------------------ | ------------------------------------ |
| `@nestjs-tools/aws-s3`           | `@nestjs-kit/s3`         | `packages/nestjskit__s3`             |
| `@nestjs-tools/cloudinary`       | `@nestjs-kit/cloudinary` | `packages/nestjskit__cloudinary`     |
| `nestjs-pubnub` (workspace name) | `@nestjs-kit/pubnub`     | `packages/nestjskit__pubnub`         |
| `nestjs-azure-storage-blob`      | Unchanged                | `packages/nestjs-azure-storage-blob` |
| `nestjs-drizzle-pg`              | Unchanged                | `packages/nestjs-drizzle-pg`         |

The `@nestjs-kit/*` packages start a new release history. Their installation commands apply after the first publication. Removal of old `@nestjs-tools/*` registry packages is a separate owner action; changing this repository does not unpublish them.

After the new packages are published, replace dependencies and imports:

```sh
pnpm remove @nestjs-tools/aws-s3 @nestjs-tools/cloudinary
pnpm add @nestjs-kit/s3 @nestjs-kit/cloudinary @aws-sdk/client-s3 cloudinary sharp
```

```ts
import { AwsS3Module, InjectAwsS3Client } from "@nestjs-kit/s3";
import { CloudinaryModule, CloudinaryService } from "@nestjs-kit/cloudinary";
```

Only remove packages you actually have installed. Update workspace links, TypeScript path aliases, and scripts that referenced the old directories.

## Configuration changes

- **Azure:** use `AzureStorageBlobModule.register()` or `registerAsync()`, and inject `AzureStorageBlobService`. Older README examples using `StorageBlobModule.forRoot()` did not match the source API. Global registration is explicit through the second argument, `{ global: true }`. SAS helpers return `{ sasUrl, headers }`, not a URL string.
- **S3:** options follow AWS SDK v3 `S3ClientConfig`. Explicit credentials are optional; the default credential provider chain is supported. Inject the client through `InjectAwsS3Client(alias?)`.
- **Cloudinary:** registration does not ping the remote API by default. Enable `pingOnInit` if desired. Wrapper upload/signing methods use their module's configuration. The raw `instance` is the shared Cloudinary SDK; pass explicit options when using it with multiple accounts.
- **PubNub:** use the current SDK's `userId` option. The injectable client closes when its Nest module is destroyed.
- **Drizzle:** pool registration is lazy. Client registration connects at startup. Enable Nest shutdown hooks in server applications when you want OS signals to trigger connection cleanup.

Refer to each package README and declared peer dependencies for the supported SDK and NestJS versions. Check upstream SDK migration notes when upgrading across major versions.

## Tooling

Replace old Nx, Jest, release-it, and ad hoc release commands with the root pnpm scripts. Use mise for the pinned toolchain. Conventional Commit PR titles feed independent package releases; see [release automation](releases.md).
