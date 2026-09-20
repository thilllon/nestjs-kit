# NestJS Kit

NestJS Kit is a monorepo of independent NestJS integrations for storage, media, PostgreSQL, email, and realtime messaging. Each package connects an existing SDK to Nest's module and dependency injection system, so application code can focus on using the service.

Install only the integrations you need. Packages have their own npm releases and usage guides, with shared tooling and maintenance in this repository.

[![CI](https://img.shields.io/github/actions/workflow/status/thilllon/nestjs-kit/ci.yml?branch=main&label=CI)](https://github.com/thilllon/nestjs-kit/actions/workflows/ci.yml)
[![License: ISC](https://img.shields.io/badge/license-ISC-blue.svg)](LICENSE)

## Pick an integration

| Package                                                                                      | npm                                                                                                                                                                             | Use it for                                                                 | Guide                                                  |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------ |
| `@nestjs-kit/s3` [(npm)](https://www.npmjs.com/package/@nestjs-kit/s3)                       | [![Monthly downloads for @nestjs-kit/s3](https://img.shields.io/npm/dm/%40nestjs-kit%2Fs3?logo=npm)](https://www.npmjs.com/package/@nestjs-kit/s3)                              | S3-compatible storage clients, including AWS, NetApp, and Ceph             | [README](packages/nestjskit__s3/README.md)             |
| `@nestjs-kit/cloudinary` [(npm)](https://www.npmjs.com/package/@nestjs-kit/cloudinary)       | [![Monthly downloads for @nestjs-kit/cloudinary](https://img.shields.io/npm/dm/%40nestjs-kit%2Fcloudinary?logo=npm)](https://www.npmjs.com/package/@nestjs-kit/cloudinary)      | Signing uploads and uploading media with Cloudinary transformation options | [README](packages/nestjskit__cloudinary/README.md)     |
| `nestjs-pubnub` [(npm)](https://www.npmjs.com/package/nestjs-pubnub)                         | [![Monthly downloads for nestjs-pubnub](https://img.shields.io/npm/dm/nestjs-pubnub?logo=npm)](https://www.npmjs.com/package/nestjs-pubnub)                                     | Publishing and subscribing through an injectable PubNub client             | [README](packages/nestjs-pubnub/README.md)             |
| `nestjs-azure-storage-blob` [(npm)](https://www.npmjs.com/package/nestjs-azure-storage-blob) | [![Monthly downloads for nestjs-azure-storage-blob](https://img.shields.io/npm/dm/nestjs-azure-storage-blob?logo=npm)](https://www.npmjs.com/package/nestjs-azure-storage-blob) | Blob storage operations and direct uploads through SAS URLs                | [README](packages/nestjs-azure-storage-blob/README.md) |
| `nestjs-drizzle-pg` [(npm)](https://www.npmjs.com/package/nestjs-drizzle-pg)                 | [![Monthly downloads for nestjs-drizzle-pg](https://img.shields.io/npm/dm/nestjs-drizzle-pg?logo=npm)](https://www.npmjs.com/package/nestjs-drizzle-pg)                         | Drizzle ORM with PostgreSQL pools or clients                               | [README](packages/nestjs-drizzle-pg/README.md)         |
| `nestjs-pg-listen` [(npm)](https://www.npmjs.com/package/nestjs-pg-listen)                   | [![Monthly downloads for nestjs-pg-listen](https://img.shields.io/npm/dm/nestjs-pg-listen?logo=npm)](https://www.npmjs.com/package/nestjs-pg-listen)                            | PostgreSQL LISTEN / NOTIFY with managed subscriber lifecycle               | [README](packages/nestjs-pg-listen/README.md)          |
| `@nestjs-kit/nodemailer` [(npm)](https://www.npmjs.com/package/@nestjs-kit/nodemailer)       | [![Monthly downloads for @nestjs-kit/nodemailer](https://img.shields.io/npm/dm/%40nestjs-kit%2Fnodemailer?logo=npm)](https://www.npmjs.com/package/@nestjs-kit/nodemailer)      | Email delivery through configurable Nodemailer transports                  | [README](packages/nestjskit__nodemailer/README.md)     |

## Shared approach

An authentication integration is also being designed in [`nestjs-slightly-better-auth`](packages/nestjs-slightly-better-auth/README.md). Its research, design reviews and reference source live in this monorepo; the workspace is private and does not provide an authentication API yet.

- **Nest-native configuration.** Register options directly or resolve them asynchronously through dependency injection. Inject the client or adapter service using Nest's standard APIs.
- **SDK access.** Use the underlying SDK's operations and types. Adapters add configuration, useful integration helpers, and connection cleanup where needed.
- **Separate integrations.** Each package is installed, versioned, and published independently. Its README documents supported registration options and lifecycle behavior.
- **Both module formats.** Every library ships ESM and CommonJS builds with matching TypeScript declarations. Package exports select the correct files for `import` and `require()`.

Choose an integration above for installation instructions and complete examples.

## Develop locally

Install [mise](https://mise.jdx.dev/getting-started.html), then:

```sh
mise trust
mise install
mise exec -- pnpm install
mise exec -- pnpm build
mise exec -- pnpm test
```

`mise.toml` defines the toolchain. Development tracks the latest Node.js LTS (currently 24) and uses a pinned stable pnpm release; pnpm does not publish an LTS channel. Turbo uses streaming output without its terminal UI.

Read [CONTRIBUTING.md](CONTRIBUTING.md) for checks, commit conventions, and pull requests. [Release automation](docs/releases.md) explains independent package versions and the one-time npm setup.

## License

The repository and established integrations use [ISC](LICENSE). The `nestjs-slightly-better-auth` workspace uses [MIT](packages/nestjs-slightly-better-auth/LICENSE), and its archived upstream source retains its [original MIT notice](packages/nestjs-slightly-better-auth/legacy/LICENSE). Consult each package's license when using its files.
