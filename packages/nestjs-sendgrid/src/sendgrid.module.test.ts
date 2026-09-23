import { Inject, Injectable } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import defaultClient from "@sendgrid/client";
import defaultMail from "@sendgrid/mail";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import type { SendGridModuleOptions } from "./sendgrid.interface";
import { SendGridModule } from "./sendgrid.module";
import { SendGridService } from "./sendgrid.service";
import { getSendGridToken } from "./sendgrid.tokens";

// The error class the installed SDK rejects with, resolved exactly as the SDK does.
const { ResponseError } = createRequire(require.resolve("@sendgrid/client"))(
  "@sendgrid/helpers",
).classes;

const message = {
  to: "reader@example.com",
  from: "sender@example.com",
  subject: "Welcome",
  text: "Hello",
};

interface ReceivedRequest {
  method?: string;
  url?: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}

/** Starts a loopback stand-in for the SendGrid API on an ephemeral port. */
async function startApi(
  status = 202,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const requests: ReceivedRequest[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString();
    requests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: text ? JSON.parse(text) : undefined,
    });
    if (status === 0) {
      return; // Never answer, to exercise client timeouts.
    }
    response.writeHead(status, {
      ...headers,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    });
    response.end(body === undefined ? undefined : JSON.stringify(body));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    requests,
    /** Sends every request of the service's client to this server. */
    route(service: SendGridService) {
      service.client.setDefaultRequest("baseUrl", `http://127.0.0.1:${port}/`);
    },
    close() {
      server.closeAllConnections();
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

type ResolvedRequest = {
  baseURL: string;
  timeout?: number;
  headers: Record<string, string>;
};

function resolveRequest(client: SendGridService["client"]) {
  // createRequest returns the resolved axios options, despite its typing.
  return client.createRequest({
    method: "POST",
    url: "/v3/mail/send",
  }) as unknown as ResolvedRequest;
}

function register(
  options: SendGridModuleOptions,
  async: boolean,
  alias?: string,
) {
  return async
    ? SendGridModule.registerAsync({ alias, useFactory: async () => options })
    : SendGridModule.register({ ...options, alias });
}

describe("SendGrid module", () => {
  it.each([false, true])(
    "isolates default and named accounts injected together (named async=%s)",
    async (namedAsync) => {
      @Injectable()
      class Consumer {
        constructor(
          readonly primary: SendGridService,
          @Inject(getSendGridToken("regional"))
          readonly regional: SendGridService,
        ) {}
      }
      const module = await Test.createTestingModule({
        imports: [
          register({ apiKey: "SG.primary" }, !namedAsync),
          register(
            {
              apiKey: "SG.regional",
              dataResidency: "eu",
              impersonateSubuser: "regional-subuser",
              timeout: 5_000,
            },
            namedAsync,
            "regional",
          ),
        ],
        providers: [Consumer],
      }).compile();
      const api = await startApi();
      try {
        const { primary, regional } = module.get(Consumer);
        expect(primary).toBe(module.get(getSendGridToken()));
        expect(regional).toBe(module.get(getSendGridToken("regional")));
        expect(regional).not.toBe(primary);
        expect(regional.client).not.toBe(primary.client);

        const primaryRequest = resolveRequest(primary.client);
        expect(primaryRequest).toMatchObject({
          baseURL: "https://api.sendgrid.com/",
          headers: { Authorization: "Bearer SG.primary" },
        });
        expect(primaryRequest.headers).not.toHaveProperty("On-Behalf-Of");
        expect(primaryRequest).not.toHaveProperty("timeout");
        expect(resolveRequest(regional.client)).toMatchObject({
          baseURL: "https://api.eu.sendgrid.com/",
          timeout: 5_000,
          headers: {
            Authorization: "Bearer SG.regional",
            "On-Behalf-Of": "regional-subuser",
          },
        });

        api.route(primary);
        api.route(regional);
        await primary.mail.send({ ...message, subject: "primary" });
        await regional.mail.send({ ...message, subject: "regional" });
        expect(
          api.requests.map(({ headers, body }) => ({
            authorization: headers.authorization,
            subuser: headers["on-behalf-of"],
            subject: (body as { subject: string }).subject,
          })),
        ).toEqual([
          {
            authorization: "Bearer SG.primary",
            subuser: undefined,
            subject: "primary",
          },
          {
            authorization: "Bearer SG.regional",
            subuser: "regional-subuser",
            subject: "regional",
          },
        ]);
      } finally {
        await module.close();
        await api.close();
      }
    },
  );

  it("never configures the SDK's default client or mail instances", async () => {
    const sharedMail = defaultMail as unknown as {
      client: typeof defaultClient;
    };
    const sharedMailClient = sharedMail.client;
    const before = [
      resolveRequest(defaultClient),
      resolveRequest(sharedMailClient),
    ];
    const module = await Test.createTestingModule({
      imports: [
        register({ apiKey: "SG.primary", timeout: 1_000 }, false),
        register(
          {
            apiKey: "SG.regional",
            dataResidency: "eu",
            impersonateSubuser: "regional-subuser",
          },
          true,
          "regional",
        ),
      ],
    }).compile();
    try {
      for (const service of [
        module.get(SendGridService),
        module.get<SendGridService>(getSendGridToken("regional")),
      ]) {
        expect(service.client).not.toBe(defaultClient);
        expect(service.mail).not.toBe(defaultMail);
      }
      expect(sharedMail.client).toBe(sharedMailClient);
      const after = [
        resolveRequest(defaultClient),
        resolveRequest(sharedMailClient),
      ];
      expect(after).toEqual(before);
      for (const request of after) {
        expect(request.baseURL).toBe("https://api.sendgrid.com/");
        expect(request.headers).not.toHaveProperty("Authorization");
        expect(request.headers).not.toHaveProperty("On-Behalf-Of");
      }
    } finally {
      await module.close();
    }
  });

  it("sends mail and Web API requests over the wire with the registration's credentials", async () => {
    const api = await startApi(202, { ok: true }, { "X-Message-Id": "m-1" });
    const module = await Test.createTestingModule({
      imports: [register({ apiKey: "SG.transactional" }, false, "mailer")],
    }).compile();
    try {
      const service = module.get<SendGridService>(getSendGridToken("mailer"));
      api.route(service);
      const [response] = await service.mail.send({ ...message });
      expect(response.statusCode).toBe(202);
      expect(response.headers["x-message-id"]).toBe("m-1");
      const [, body] = await service.client.request({
        method: "GET",
        url: "/v3/scopes",
      });
      expect(body).toEqual({ ok: true });

      expect(api.requests).toHaveLength(2);
      const [sent, scopes] = api.requests;
      expect(sent).toMatchObject({
        method: "POST",
        url: "/v3/mail/send",
        headers: {
          authorization: "Bearer SG.transactional",
          "content-type": "application/json",
          "user-agent": expect.stringMatching(/^sendgrid\/8\.\d+\.\d+;nodejs$/),
        },
      });
      expect(sent.body).toEqual({
        from: { email: "sender@example.com" },
        subject: "Welcome",
        personalizations: [{ to: [{ email: "reader@example.com" }] }],
        content: [{ type: "text/plain", value: "Hello" }],
      });
      expect(scopes).toMatchObject({
        method: "GET",
        url: "/v3/scopes",
        headers: { authorization: "Bearer SG.transactional" },
      });
    } finally {
      await module.close();
      await api.close();
    }
  });

  it("rejects API errors with the SDK's ResponseError unchanged", async () => {
    const errors = [
      {
        message: "The from address does not match a verified Sender Identity.",
        field: "from",
        help: null,
      },
    ];
    const api = await startApi(403, { errors });
    const service = new SendGridService({ apiKey: "SG.unverified" });
    try {
      api.route(service);
      const error = await service.mail.send({ ...message }).then(
        () => undefined,
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(ResponseError);
      expect(error).toMatchObject({
        code: 403,
        response: { body: { errors } },
      });
    } finally {
      await api.close();
    }
  });

  it("applies the configured timeout and propagates transport errors unchanged", async () => {
    const api = await startApi(0);
    const service = new SendGridService({ apiKey: "SG.slow", timeout: 50 });
    try {
      api.route(service);
      const error = await service.mail.send({ ...message }).then(
        () => undefined,
        (reason: unknown) => reason,
      );
      expect(error).not.toBeInstanceOf(ResponseError);
      expect(error).toMatchObject({
        name: "AxiosError",
        code: "ECONNABORTED",
        message: "timeout of 50ms exceeded",
      });
      expect(api.requests).toHaveLength(1);
    } finally {
      await api.close();
    }
  });

  it.each(
    [
      {
        problem: "an unsupported region",
        options: { apiKey: "SG.valid", dataResidency: "us" },
        error: 'dataResidency must be "global" or "eu"; received "us"',
      },
      {
        problem: "a region in the wrong case",
        options: { apiKey: "SG.valid", dataResidency: "EU" },
        error: 'dataResidency must be "global" or "eu"; received "EU"',
      },
      {
        problem: "a blank API key",
        options: { apiKey: " " },
        error: "requires a non-empty apiKey",
      },
      {
        problem: "a missing API key",
        options: {},
        error: "requires a non-empty apiKey",
      },
      {
        problem: "a timeout parsed from an unset variable",
        options: { apiKey: "SG.valid", timeout: Number(undefined) },
        error:
          "timeout must be a number of milliseconds from 0 to 2147483647; received NaN",
      },
      {
        problem: "a negative timeout",
        options: { apiKey: "SG.valid", timeout: -1 },
        error:
          "timeout must be a number of milliseconds from 0 to 2147483647; received -1",
      },
      {
        problem: "an infinite timeout",
        options: { apiKey: "SG.valid", timeout: Number.POSITIVE_INFINITY },
        error:
          "timeout must be a number of milliseconds from 0 to 2147483647; received Infinity",
      },
      {
        problem: "a timeout that overflows Node's timer limit",
        options: { apiKey: "SG.valid", timeout: Number.MAX_SAFE_INTEGER },
        error:
          "timeout must be a number of milliseconds from 0 to 2147483647; received 9007199254740991",
      },
      {
        problem: "an unparsed timeout string",
        options: { apiKey: "SG.valid", timeout: "5000" },
        error:
          'timeout must be a number of milliseconds from 0 to 2147483647; received "5000"',
      },
    ].flatMap((scenario) =>
      [false, true].map((async) => ({ ...scenario, async })),
    ),
  )(
    "fails registration with $problem before any request is sent (async=$async)",
    async ({ options, error, async }) => {
      const registration = register(
        options as unknown as SendGridModuleOptions,
        async,
        "invalid",
      );
      await expect(
        Test.createTestingModule({ imports: [registration] }).compile(),
      ).rejects.toThrow(error);
    },
  );
});
