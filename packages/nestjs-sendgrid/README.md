# nestjs-sendgrid

**Twilio SendGrid for NestJS.** Register one or more SendGrid accounts, inject them into your services, and keep using the official SDK's Mail Send and Web API clients.

[![npm version](https://img.shields.io/npm/v/nestjs-sendgrid)](https://www.npmjs.com/package/nestjs-sendgrid)
[![npm monthly downloads](https://img.shields.io/npm/dm/nestjs-sendgrid)](https://www.npmjs.com/package/nestjs-sendgrid)
[![CI](https://img.shields.io/github/actions/workflow/status/thilllon/nestjs-kit/ci.yml?branch=main)](https://github.com/thilllon/nestjs-kit/actions/workflows/ci.yml)

## Install

```sh
pnpm add nestjs-sendgrid @sendgrid/mail @sendgrid/client
```

Requires **Node.js 24+**, **NestJS 12**, and **SendGrid Node.js SDK 8** (`@sendgrid/mail` and `@sendgrid/client`). Ships ESM, CommonJS, and TypeScript declarations. The SDK packages include their own types.

## Send an email

```ts
import { Injectable, Module } from "@nestjs/common";
import { SendGridModule, SendGridService } from "nestjs-sendgrid";

@Injectable()
export class NotificationsService {
  constructor(private readonly sendgrid: SendGridService) {}

  welcome(to: string) {
    return this.sendgrid.mail.send({
      to,
      from: "notifications@example.com",
      subject: "Welcome",
      text: "Your account is ready.",
    });
  }
}

@Module({
  imports: [
    SendGridModule.register({
      apiKey: process.env.SENDGRID_API_KEY!,
    }),
  ],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
```

Set `SENDGRID_API_KEY` in your application environment and replace the sender with a verified sender identity of your account. `mail.send()` returns the SDK's `[response, body]` tuple; a successful send resolves with status code `202`.

| Option               | Purpose                                                                                                           |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `apiKey`             | Required. API key sent as a Bearer token.                                                                         |
| `dataResidency`      | `"global"` (default, `api.sendgrid.com`) or `"eu"` (`api.eu.sendgrid.com`).                                       |
| `timeout`            | Request timeout in milliseconds for every request of this registration, up to `2147483647`; `0` disables it.      |
| `impersonateSubuser` | [Subuser](https://www.twilio.com/docs/sendgrid/ui/account-and-settings/subusers) username sent as `On-Behalf-Of`. |

Registration fails with a clear error when `apiKey` is empty, `dataResidency` is not `"global"` or `"eu"`, or `timeout` is not a number from `0` to `2147483647` (Node's timer limit; use `0` for no timeout). Without these checks, the SDK would only warn and keep sending through the global host, and axios would ignore an invalid timeout or fail at request time. Keys that do not start with `SG.` still produce the SDK's own console warning.

## Asynchronous configuration

Install `@nestjs/config` if you use this example, then place the registration in your module's `imports`:

```ts
import { ConfigModule, ConfigService } from "@nestjs/config";
import { SendGridModule } from "nestjs-sendgrid";

SendGridModule.registerAsync({
  imports: [ConfigModule.forRoot()],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    apiKey: config.getOrThrow<string>("SENDGRID_API_KEY"),
    dataResidency: "eu",
  }),
});
```

`registerAsync()` also accepts `useClass` and `useExisting`. These factories implement `create()` and return `SendGridModuleOptions` or a promise of it. Set `isGlobal: true` in either registration to make it global; the default is local to its importing module.

## Multiple accounts

Give each registration a unique `alias` and inject the matching service with `@Inject(getSendGridToken(alias))`. `alias` and `isGlobal` are Nest module settings: place them beside `useFactory` for asynchronous registration, not inside its returned options. For synchronous registration, include them alongside the SendGrid options in the same object.

```ts
import { Inject, Injectable, Module } from "@nestjs/common";
import {
  getSendGridToken,
  SendGridModule,
  SendGridService,
} from "nestjs-sendgrid";

@Injectable()
export class MailRouter {
  constructor(
    @Inject(getSendGridToken("transactional"))
    readonly transactional: SendGridService,
    @Inject(getSendGridToken("marketing"))
    readonly marketing: SendGridService,
  ) {}
}

@Module({
  imports: [
    SendGridModule.register({
      alias: "transactional",
      apiKey: process.env.SENDGRID_TRANSACTIONAL_KEY!,
    }),
    SendGridModule.registerAsync({
      alias: "marketing",
      useFactory: () => ({
        apiKey: process.env.SENDGRID_MARKETING_KEY!,
        dataResidency: "eu",
        impersonateSubuser: "marketing-eu",
      }),
    }),
  ],
  providers: [MailRouter],
})
export class MailModule {}
```

Each registration owns its API key, region, timeout, subuser and SDK instances; changing one registration's client never affects another. Named registrations export only their named token. Omit `alias` (or use `""` or the reserved `"default"` alias) to keep ordinary `SendGridService` injection. Other aliases are exact, opaque names: use a distinct alias for every registration you inject together.

## SDK access

`SendGridService.mail` is a `MailService` from `@sendgrid/mail`, and `SendGridService.client` is a `Client` from `@sendgrid/client`. The mail service sends through that same client. Use the client for any [Web API v3](https://www.twilio.com/docs/sendgrid/api-reference) endpoint:

```ts
import { Injectable } from "@nestjs/common";
import { SendGridService } from "nestjs-sendgrid";

@Injectable()
export class SuppressionsService {
  constructor(private readonly sendgrid: SendGridService) {}

  async bounces() {
    const [, body] = await this.sendgrid.client.request({
      method: "GET",
      url: "/v3/suppression/bounces",
    });
    return body;
  }
}
```

The module never configures the SDK's process-wide default exports (`import sgMail from "@sendgrid/mail"` and `import client from "@sendgrid/client"`). Code that still configures those defaults neither affects registrations nor is affected by them.

## Lifecycle and errors

Registration creates the clients without contacting SendGrid or verifying the API key. The SDK sends requests through axios with Node's shared HTTP agents and keeps no connections of its own, so the module has nothing to close during Nest shutdown.

HTTP error responses reject with the SDK's `ResponseError` unchanged: read `error.code` for the status and `error.response.body` for SendGrid's error details. Timeouts and network failures reject with the underlying `AxiosError`, whose `config` and `request` include the `Authorization: Bearer <apiKey>` header. Logging the whole error object, as Nest's default exception filter does for an uncaught error, writes the API key to your logs: catch transport errors and log only safe fields such as `error.code` and `error.message`, or remove `config` and `request` before logging or rethrowing. `ResponseError` does not carry the key. The adapter adds no retries or templating.

## Local tests without the network

Point a registration's client at a local HTTP server after it is created:

```ts
import { Test } from "@nestjs/testing";
import { SendGridModule, SendGridService } from "nestjs-sendgrid";

const moduleRef = await Test.createTestingModule({
  imports: [SendGridModule.register({ apiKey: "SG.test" })],
}).compile();
const sendgrid = moduleRef.get(SendGridService);
sendgrid.client.setDefaultRequest("baseUrl", "http://127.0.0.1:3025/");
```

This package's tests use a loopback server on an ephemeral port to exercise real Mail Send and Web API round trips, API error responses and timeouts without credentials. To validate requests against SendGrid without delivering mail, use its [sandbox mode](https://www.twilio.com/docs/sendgrid/for-developers/sending-email/sandbox-mode).

## API

| API                                     | Purpose                                                         |
| --------------------------------------- | --------------------------------------------------------------- |
| `SendGridModule.register(options)`      | Register an account with static options.                        |
| `SendGridModule.registerAsync(options)` | Resolve an account's options through Nest dependency injection. |
| `SendGridService.mail`                  | Send email through this registration.                           |
| `SendGridService.client`                | Call the Web API through this registration.                     |
| `getSendGridToken(alias?)`              | Injection token of a registration's `SendGridService`.          |
| `getSendGridOptionsToken()`             | Module-local options token (see below).                         |

## Module options token

`getSendGridOptionsToken()` returns the module-local configuration token for custom providers inside a registration. It takes no alias: each registration owns its options provider. The options provider is not exported to parent or importing modules; use this helper only for providers added inside that registration or for registration-local tests. The generated builder token is private and is not exported from the package entry point.

[Mail Send API](https://www.twilio.com/docs/sendgrid/api-reference/mail-send/mail-send) · [SendGrid Node.js SDK](https://github.com/sendgrid/sendgrid-nodejs) · [Contributing](https://github.com/thilllon/nestjs-kit/blob/main/CONTRIBUTING.md)
