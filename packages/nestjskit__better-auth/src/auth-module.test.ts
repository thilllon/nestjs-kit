import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { BetterAuthModule } from "./auth-module.js";
import type { BetterAuthService } from "./auth-service.js";
import { getBetterAuthServiceToken } from "./auth-tokens.js";
import { createTestAuth } from "./test-fixtures.js";

describe("BetterAuthModule", () => {
  it("injects distinct named services around the original auth objects", async () => {
    const primary = createTestAuth();
    const admin = createTestAuth({ advanced: { cookiePrefix: "admin" } });
    const module = await Test.createTestingModule({
      imports: [
        BetterAuthModule.forRoot({ auth: primary, http: { mount: false } }),
        BetterAuthModule.forRoot({
          name: "admin",
          auth: admin,
          http: { mount: false },
        }),
      ],
    }).compile();
    try {
      await module.init();
      expect(
        module.get<BetterAuthService>(getBetterAuthServiceToken()).instance,
      ).toBe(primary);
      expect(
        module.get<BetterAuthService>(getBetterAuthServiceToken("admin"))
          .instance,
      ).toBe(admin);
    } finally {
      await module.close();
    }
  });
});

it("resolves async dependencies and keeps the default class alias", async () => {
  const { Module } = await import("@nestjs/common");
  const { BetterAuthService } = await import("./auth-service.js");
  const primary = createTestAuth();
  const secondary = createTestAuth({ advanced: { cookiePrefix: "secondary" } });
  @Module({
    providers: [
      {
        provide: "AUTH_FACTORY",
        useFactory: async () => {
          await Promise.resolve();
          return primary;
        },
      },
    ],
    exports: ["AUTH_FACTORY"],
  })
  class FactoryModule {}
  const module = await Test.createTestingModule({
    imports: [
      BetterAuthModule.forRootAsync({
        imports: [FactoryModule],
        inject: ["AUTH_FACTORY"],
        useFactory: (auth: typeof primary) => ({
          auth,
          http: { mount: false },
        }),
      }),
      BetterAuthModule.forRoot({
        name: "secondary",
        auth: secondary,
        http: { mount: false },
      }),
    ],
  }).compile();
  try {
    await module.init();
    expect(module.get(BetterAuthService)).toBe(
      module.get(getBetterAuthServiceToken()),
    );
    expect(module.get(BetterAuthService).api).toBe(primary.api);
    expect(module.get(BetterAuthService).context()).toBe(primary.$context);
    expect(module.get(BetterAuthService).mount()).toBeUndefined();
    expect(
      module.get<BetterAuthService>(getBetterAuthServiceToken("secondary"))
        .instance,
    ).toBe(secondary);
  } finally {
    await module.close();
  }
});

it("rejects runtime factory attempts to change static provider shape", async () => {
  await expect(
    Test.createTestingModule({
      imports: [
        BetterAuthModule.forRootAsync({
          useFactory: () =>
            ({ auth: createTestAuth(), globalGuard: false }) as never,
        }),
      ],
    }).compile(),
  ).rejects.toThrow("'globalGuard' was returned from useFactory");
});

it("resolves extension classes, existing providers and async factories with exports", async () => {
  const { Inject } = await import("@nestjs/common");
  const { defineExtension } = await import("./auth-module-definition.js");
  const { INSTANCE_REGISTRY } = await import("./auth-tokens.js");
  class Source {
    readonly id = "factory-source";
    readonly kinds = ["session"] as const;
    constructor(@Inject("value") readonly value: string) {}

    async resolve() {
      return { outcome: "absent" } as const;
    }
  }
  const module = await Test.createTestingModule({
    imports: [
      BetterAuthModule.forRoot({
        auth: createTestAuth(),
        http: { mount: false },
        principals: [
          defineExtension({
            providers: [{ provide: "value", useValue: "injected" }],
            exports: ["value"],
            use: { useClass: Source },
          }),
          defineExtension({
            providers: [
              {
                provide: "existing-source",
                useValue: {
                  id: "existing",
                  kinds: ["session"],
                  resolve: async () => ({ outcome: "absent" }),
                },
              },
            ],
            use: { useExisting: "existing-source" },
          }),
          defineExtension({
            use: {
              useFactory: async () => ({
                id: "async",
                kinds: ["session"] as const,
                resolve: async () => ({ outcome: "absent" as const }),
              }),
            },
          }),
        ],
      }),
    ],
  }).compile();
  try {
    await module.init();
    const registry =
      module.get<import("./instance-registry.js").InstanceRegistry>(
        INSTANCE_REGISTRY,
      );
    expect(registry.get("default").sources.map((source) => source.id)).toEqual([
      "factory-source",
      "existing",
      "async",
      "better-auth:session",
    ]);
    expect((registry.get("default").sources[0] as Source).value).toBe(
      "injected",
    );
    expect(module.get("value")).toBe("injected");
  } finally {
    await module.close();
  }
});
