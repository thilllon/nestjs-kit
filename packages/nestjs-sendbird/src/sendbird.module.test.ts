import { Inject, Injectable } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import {
  type RequestContext,
  ResponseContext,
  SelfDecodingBody,
  server1,
  wrapHttpLibrary,
} from "@sendbird/sendbird-platform-sdk-typescript";
import { describe, expect, it } from "vitest";
import type { SendbirdModuleOptions } from "./sendbird.interface";
import { SendbirdModule } from "./sendbird.module";
import { SendbirdService } from "./sendbird.service";
import { getSendbirdToken } from "./sendbird.tokens";

/** Records each request built by the real SDK instead of sending it. */
function recorder() {
  const requests: { url: string; token?: string }[] = [];
  const httpApi = wrapHttpLibrary({
    async send(request: RequestContext) {
      requests.push({
        url: request.getUrl(),
        token: request.getHeaders()["api-token"],
      });
      const body = Buffer.from(JSON.stringify({ user_id: "reader" }));
      return new ResponseContext(
        200,
        { "content-type": "application/json" },
        new SelfDecodingBody(Promise.resolve(body)),
      );
    },
  });
  return { httpApi, requests };
}

function registration(
  options: SendbirdModuleOptions,
  async: boolean,
  alias?: string,
) {
  const extras = alias === undefined ? {} : { alias };
  return async
    ? SendbirdModule.registerAsync({
        ...extras,
        useFactory: async () => options,
      })
    : SendbirdModule.register({ ...options, ...extras });
}

describe("Sendbird registrations", () => {
  it.each([false, true])(
    "injects default and named applications with their own host and token (default async=%s)",
    async (defaultAsync) => {
      @Injectable()
      class Consumer {
        constructor(
          readonly primary: SendbirdService,
          @Inject(getSendbirdToken("secondary"))
          readonly secondary: SendbirdService,
        ) {}
      }
      const primary = recorder();
      const secondary = recorder();
      const module = await Test.createTestingModule({
        imports: [
          registration(
            {
              appId: "PRIMARY-APP",
              apiToken: "primary-token",
              configuration: { httpApi: primary.httpApi },
            },
            defaultAsync,
          ),
          registration(
            {
              appId: "secondary-app",
              apiToken: "secondary-token",
              configuration: { httpApi: secondary.httpApi },
            },
            !defaultAsync,
            "secondary",
          ),
        ],
        providers: [Consumer],
      }).compile();
      try {
        const consumer = module.get(Consumer);
        expect(consumer.primary).not.toBe(consumer.secondary);
        expect(consumer.primary).toBe(module.get(SendbirdService));
        expect(consumer.secondary).toBe(module.get("SENDBIRD_secondary"));
        await expect(
          consumer.primary.users.viewAUser({ userId: "reader" }),
        ).resolves.toMatchObject({ userId: "reader" });
        await consumer.secondary.users.viewAUser({ userId: "reader" });
        expect(primary.requests).toEqual([
          {
            url: "https://api-primary-app.sendbird.com/v3/users/reader",
            token: "primary-token",
          },
        ]);
        expect(secondary.requests).toEqual([
          {
            url: "https://api-secondary-app.sendbird.com/v3/users/reader",
            token: "secondary-token",
          },
        ]);
      } finally {
        await module.close();
      }
    },
  );

  it("leaves the SDK's shared server and a reused caller configuration untouched", async () => {
    const { httpApi, requests } = recorder();
    const seen: string[] = [];
    const counter = {
      pre: async (context: RequestContext) => {
        seen.push(context.getUrl());
        return context;
      },
      post: async (response: ResponseContext) => response,
    };
    const configuration = {
      httpApi,
      middleware: [],
      promiseMiddleware: [counter],
    };
    const aliases = ["first", "second"];
    const module = await Test.createTestingModule({
      imports: aliases.map((alias) =>
        SendbirdModule.register({
          alias,
          appId: alias,
          apiToken: `${alias}-token`,
          configuration,
        }),
      ),
    }).compile();
    try {
      for (const alias of aliases) {
        await module
          .get<SendbirdService>(getSendbirdToken(alias))
          .users.viewAUser({ userId: "reader" });
      }
      expect(seen).toEqual([
        "https://api-first.sendbird.com/v3/users/reader",
        "https://api-second.sendbird.com/v3/users/reader",
      ]);
      expect(requests.map(({ token }) => token)).toEqual([
        "first-token",
        "second-token",
      ]);
      expect(configuration).toEqual({
        httpApi,
        middleware: [],
        promiseMiddleware: [counter],
      });
      expect(server1.getConfiguration()).toEqual({ app_id: "APP_ID" });
    } finally {
      await module.close();
    }
  });

  it.each([
    { apiToken: "token" },
    { appId: "", apiToken: "token" },
    { appId: "attacker.example/", apiToken: "token" },
    { appId: "app" },
    { appId: "app", apiToken: "" },
    { appId: "app", apiToken: "token\n" },
  ])(
    "rejects a registration without a usable application ID and token: %j",
    async (options) => {
      await expect(
        Test.createTestingModule({
          imports: [
            SendbirdModule.registerAsync({
              useFactory: () => options as SendbirdModuleOptions,
            }),
          ],
        }).compile(),
      ).rejects.toThrow(/^SendbirdModule requires/);
    },
  );
});
