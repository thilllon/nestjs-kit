# @nestjs-kit/nodemailer

**Nodemailer for NestJS.** Configure one transporter, inject it into your services, and keep using Nodemailer's message options and transport plugins.

[![npm version](https://img.shields.io/npm/v/%40nestjs-kit%2Fnodemailer)](https://www.npmjs.com/package/@nestjs-kit/nodemailer)
[![npm downloads](https://img.shields.io/npm/dm/%40nestjs-kit%2Fnodemailer)](https://www.npmjs.com/package/@nestjs-kit/nodemailer)
[![CI](https://img.shields.io/github/actions/workflow/status/thilllon/nestjs-kit/ci.yml?branch=main)](https://github.com/thilllon/nestjs-kit/actions/workflows/ci.yml)

## Install

```sh
pnpm add @nestjs-kit/nodemailer nodemailer
```

Requires **Node.js 24+**, **NestJS 12**, and **Nodemailer 10**. Ships ESM, CommonJS, and TypeScript declarations. Nodemailer 10 includes its own types; no `@types/nodemailer` package is needed.

## Send a message

```ts
import { Injectable, Module } from "@nestjs/common";
import { NodemailerModule, NodemailerService } from "@nestjs-kit/nodemailer";

@Injectable()
export class NotificationsService {
  constructor(private readonly mailer: NodemailerService) {}

  welcome(to: string) {
    return this.mailer.sendMail({
      to,
      subject: "Welcome",
      text: "Your account is ready.",
    });
  }
}

@Module({
  imports: [
    NodemailerModule.register({
      transport: {
        host: "smtp.example.com",
        port: 587,
        secure: false,
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASSWORD,
        },
      },
      defaults: { from: "Notifications <notifications@example.com>" },
    }),
  ],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
```

Replace the example host and sender with your mail provider's settings and set the credentials in your application environment. On port 587, `secure: false` allows STARTTLS; use `secure: true` for implicit TLS on port 465. See [Nodemailer's SMTP options](https://nodemailer.com/smtp).

`sendMail()` returns the SDK result, including the message ID and envelope. Message fields override `defaults`; transport errors reject the returned promise unchanged. The adapter does not add retries or template rendering.

## Asynchronous configuration

Install `@nestjs/config` if you use this example, then place the registration in your module's `imports`:

```ts
import { ConfigModule, ConfigService } from "@nestjs/config";
import { NodemailerModule } from "@nestjs-kit/nodemailer";

NodemailerModule.registerAsync({
  imports: [ConfigModule.forRoot()],
  inject: [ConfigService],
  useFactory: async (config: ConfigService) => ({
    transport: config.getOrThrow<string>("SMTP_URL"),
    defaults: { from: config.getOrThrow<string>("MAIL_FROM") },
  }),
});
```

`registerAsync()` also accepts `useClass` and `useExisting`. These factories implement `create()` and return `NodemailerModuleOptions` or a promise of it. Set `global: true` in either registration to make the configured module global; the default is local to its importing module.

## Transport options and direct SDK access

`transport` accepts Nodemailer's SMTP configuration, SMTP URL, built-in transport options, or a custom transport plugin. For example, enable pooled SMTP with `{ host, port, secure, auth, pool: true, maxConnections: 5 }`.

Use `@InjectNodemailer()` when you need the raw transporter for plugins, events, or callback APIs:

```ts
import { Injectable } from "@nestjs/common";
import type { Transporter } from "nodemailer";
import { InjectNodemailer } from "@nestjs-kit/nodemailer";

@Injectable()
export class MailTransportService {
  constructor(@InjectNodemailer() readonly transporter: Transporter) {}
}
```

Register this provider in the module that imports `NodemailerModule`. `NodemailerService.transporter` exposes the same SDK instance.

## Connection lifecycle

Registration creates the transporter without sending mail or verifying the server connection. Call `await mailer.verify()` explicitly when you want an SMTP connection and authentication check. It resolves to `true` on success, returns `false` for transports that do not implement verification, and propagates errors.

The module closes its transporter during Nest shutdown, including pooled SMTP connections. Enable signal hooks in your Nest application with `app.enableShutdownHooks()`, or call `app.close()` explicitly. Closing follows [Nodemailer's pool semantics](https://nodemailer.com/smtp/pooled): it is not a promise that all queued messages have been delivered.

## Local tests without SMTP

Use Nodemailer's JSON transport to inspect a message without contacting a mail server:

```ts
NodemailerModule.register({
  transport: { jsonTransport: true },
  defaults: { from: "test@example.com" },
});

// After injecting NodemailerService:
const info = await mailer.sendMail({
  to: "reader@example.com",
  subject: "Test message",
  text: "Hello",
});
const message = JSON.parse(String(info.message));
```

This package's tests use the real JSON transport for message construction and custom offline transports for error propagation and shutdown behavior.

## API

| API                                       | Purpose                                                |
| ----------------------------------------- | ------------------------------------------------------ |
| `NodemailerModule.register(options)`      | Configure the transport and optional message defaults. |
| `NodemailerModule.registerAsync(options)` | Resolve options through Nest dependency injection.     |
| `NodemailerService.sendMail(message)`     | Send a message and return the SDK result.              |
| `NodemailerService.verify()`              | Explicitly check a supported transport's connection.   |
| `NodemailerService.transporter`           | Access the underlying Nodemailer transporter.          |
| `@InjectNodemailer()`                     | Inject that transporter directly.                      |

[Message options](https://nodemailer.com/message) · [Transport documentation](https://nodemailer.com/transports) · [Contributing](https://github.com/thilllon/nestjs-kit/blob/main/CONTRIBUTING.md)
