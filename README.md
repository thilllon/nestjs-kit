# NestJS Kit

NestJS Kit is a monorepo of independent NestJS integrations for storage, media, PostgreSQL, email, chat, and realtime messaging. Each package connects an existing SDK to Nest's module and dependency injection system, so application code can focus on using the service.

Install only the integrations you need. Packages have their own npm releases and usage guides, with shared tooling and maintenance in this repository.

[![CI](https://img.shields.io/github/actions/workflow/status/thilllon/nestjs-kit/ci.yml?branch=main&label=CI)](https://github.com/thilllon/nestjs-kit/actions/workflows/ci.yml)
[![License: ISC](https://img.shields.io/badge/license-ISC-blue.svg)](LICENSE)

## Pick an integration

Each guide covers installation, registration options and complete examples.

- [`@nestjs-kit/s3`](packages/nestjskit__s3/README.md): S3-compatible storage clients, including AWS, NetApp and Ceph. [npm](https://www.npmjs.com/package/@nestjs-kit/s3)
- [`nestjs-azure-storage-blob`](packages/nestjs-azure-storage-blob/README.md): Azure Blob Storage operations and direct uploads through SAS URLs. [npm](https://www.npmjs.com/package/nestjs-azure-storage-blob)
- [`@nestjs-kit/cloudinary`](packages/nestjskit__cloudinary/README.md): signed uploads and media uploads with Cloudinary transformation options. [npm](https://www.npmjs.com/package/@nestjs-kit/cloudinary)
- [`nestjs-drizzle-pg`](packages/nestjs-drizzle-pg/README.md): Drizzle ORM with PostgreSQL pools or clients. [npm](https://www.npmjs.com/package/nestjs-drizzle-pg)
- [`nestjs-pg-listen`](packages/nestjs-pg-listen/README.md): PostgreSQL LISTEN / NOTIFY with a managed subscriber lifecycle. [npm](https://www.npmjs.com/package/nestjs-pg-listen)
- [`@nestjs-kit/nodemailer`](packages/nestjskit__nodemailer/README.md): email delivery through configurable Nodemailer transports. [npm](https://www.npmjs.com/package/@nestjs-kit/nodemailer)
- [`nestjs-sendgrid`](packages/nestjs-sendgrid/README.md): Mail Send and Web API calls through isolated Twilio SendGrid accounts. [npm](https://www.npmjs.com/package/nestjs-sendgrid)
- [`nestjs-pubnub`](packages/nestjs-pubnub/README.md): publishing and subscribing through an injectable PubNub client. [npm](https://www.npmjs.com/package/nestjs-pubnub)
- [`nestjs-sendbird`](packages/nestjs-sendbird/README.md): Sendbird Platform API calls with per-application tokens. [npm](https://www.npmjs.com/package/nestjs-sendbird)

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
