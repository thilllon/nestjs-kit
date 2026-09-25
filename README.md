# NestJS Kit

NestJS Kit is a monorepo of independent NestJS integrations for storage, media, PostgreSQL, email, chat, and realtime messaging. Each package connects an existing SDK to Nest's module and dependency injection system, so application code can focus on using the service.

Install only the integrations you need. Packages have their own npm releases and usage guides, with shared tooling and maintenance in this repository.

[![CI](https://img.shields.io/github/actions/workflow/status/thilllon/nestjs-kit/ci.yml?branch=main&label=CI)](https://github.com/thilllon/nestjs-kit/actions/workflows/ci.yml)
[![License: ISC](https://img.shields.io/badge/license-ISC-blue.svg)](LICENSE)

## Packages

Each package README covers installation and usage.

- [`nestjs-azure-storage-blob`](packages/nestjs-azure-storage-blob/README.md) [![npm version of nestjs-azure-storage-blob](https://img.shields.io/npm/v/nestjs-azure-storage-blob)](https://www.npmjs.com/package/nestjs-azure-storage-blob) [![Monthly npm downloads of nestjs-azure-storage-blob](https://img.shields.io/npm/dm/nestjs-azure-storage-blob)](https://www.npmjs.com/package/nestjs-azure-storage-blob)
  - Azure Blob Storage operations and direct uploads through SAS URLs.
- [`nestjs-drizzle-pg`](packages/nestjs-drizzle-pg/README.md) [![npm version of nestjs-drizzle-pg](https://img.shields.io/npm/v/nestjs-drizzle-pg)](https://www.npmjs.com/package/nestjs-drizzle-pg) [![Monthly npm downloads of nestjs-drizzle-pg](https://img.shields.io/npm/dm/nestjs-drizzle-pg)](https://www.npmjs.com/package/nestjs-drizzle-pg)
  - Drizzle ORM with PostgreSQL pools or clients.
- [`@nestjs-kit/cloudinary`](packages/nestjskit__cloudinary/README.md) [![npm version of @nestjs-kit/cloudinary](https://img.shields.io/npm/v/%40nestjs-kit%2Fcloudinary)](https://www.npmjs.com/package/@nestjs-kit/cloudinary) [![Monthly npm downloads of @nestjs-kit/cloudinary](https://img.shields.io/npm/dm/%40nestjs-kit%2Fcloudinary)](https://www.npmjs.com/package/@nestjs-kit/cloudinary)
  - Signed uploads and media uploads with Cloudinary transformation options.
- [`@nestjs-kit/nodemailer`](packages/nestjskit__nodemailer/README.md) [![npm version of @nestjs-kit/nodemailer](https://img.shields.io/npm/v/%40nestjs-kit%2Fnodemailer)](https://www.npmjs.com/package/@nestjs-kit/nodemailer) [![Monthly npm downloads of @nestjs-kit/nodemailer](https://img.shields.io/npm/dm/%40nestjs-kit%2Fnodemailer)](https://www.npmjs.com/package/@nestjs-kit/nodemailer)
  - Email delivery through configurable Nodemailer transports.
- [`@nestjs-kit/s3`](packages/nestjskit__s3/README.md) [![npm version of @nestjs-kit/s3](https://img.shields.io/npm/v/%40nestjs-kit%2Fs3)](https://www.npmjs.com/package/@nestjs-kit/s3) [![Monthly npm downloads of @nestjs-kit/s3](https://img.shields.io/npm/dm/%40nestjs-kit%2Fs3)](https://www.npmjs.com/package/@nestjs-kit/s3)
  - S3-compatible storage clients, including AWS, NetApp and Ceph.
- [`nestjs-pg-listen`](packages/nestjs-pg-listen/README.md) [![npm version of nestjs-pg-listen](https://img.shields.io/npm/v/nestjs-pg-listen)](https://www.npmjs.com/package/nestjs-pg-listen) [![Monthly npm downloads of nestjs-pg-listen](https://img.shields.io/npm/dm/nestjs-pg-listen)](https://www.npmjs.com/package/nestjs-pg-listen)
  - PostgreSQL LISTEN / NOTIFY with a managed subscriber lifecycle.
- [`nestjs-pubnub`](packages/nestjs-pubnub/README.md) [![npm version of nestjs-pubnub](https://img.shields.io/npm/v/nestjs-pubnub)](https://www.npmjs.com/package/nestjs-pubnub) [![Monthly npm downloads of nestjs-pubnub](https://img.shields.io/npm/dm/nestjs-pubnub)](https://www.npmjs.com/package/nestjs-pubnub)
  - Publishing and subscribing through an injectable PubNub client.
- [`nestjs-sendbird`](packages/nestjs-sendbird/README.md) [![npm version of nestjs-sendbird](https://img.shields.io/npm/v/nestjs-sendbird)](https://www.npmjs.com/package/nestjs-sendbird) [![Monthly npm downloads of nestjs-sendbird](https://img.shields.io/npm/dm/nestjs-sendbird)](https://www.npmjs.com/package/nestjs-sendbird)
  - Sendbird Platform API calls with per-application tokens.
- [`nestjs-sendgrid`](packages/nestjs-sendgrid/README.md) [![npm version of nestjs-sendgrid](https://img.shields.io/npm/v/nestjs-sendgrid)](https://www.npmjs.com/package/nestjs-sendgrid) [![Monthly npm downloads of nestjs-sendgrid](https://img.shields.io/npm/dm/nestjs-sendgrid)](https://www.npmjs.com/package/nestjs-sendgrid)
  - Mail Send and Web API calls through isolated Twilio SendGrid accounts.
- [`nestjs-slightly-better-auth`](packages/nestjs-slightly-better-auth/README.md) [![npm version of nestjs-slightly-better-auth](https://img.shields.io/npm/v/nestjs-slightly-better-auth)](https://www.npmjs.com/package/nestjs-slightly-better-auth) [![Monthly npm downloads of nestjs-slightly-better-auth](https://img.shields.io/npm/dm/nestjs-slightly-better-auth)](https://www.npmjs.com/package/nestjs-slightly-better-auth)
  - Better Auth sessions, guards and authorization for NestJS applications.

## Shared approach

- **Nest-native configuration.** Register options directly or resolve them asynchronously through dependency injection. Inject the client or adapter service using Nest's standard APIs.
- **SDK access.** Use the underlying SDK's operations and types. Adapters add configuration, useful integration helpers, and connection cleanup where needed.
- **Separate integrations.** Each package is installed, versioned, and published independently. Its README documents supported registration options and lifecycle behavior.
- **Both module formats.** Every library ships ESM and CommonJS builds with matching TypeScript declarations. Package exports select the correct files for `import` and `require()`.

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

The repository and its packages use [ISC](LICENSE) unless a package's own `LICENSE` file states otherwise. Consult each package's license when using its files.
