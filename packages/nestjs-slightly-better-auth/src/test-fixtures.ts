import type {
  INestApplication,
  ModuleMetadata,
  Provider,
  Type,
} from "@nestjs/common";
import type { AbstractHttpAdapter } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { getAuthTables } from "better-auth/db";
import type {
  AuthTransport,
  BetterAuthAppOptions,
  BetterAuthRuntimeOptions,
  BetterAuthStaticOptions,
  ExtensionRef,
  HttpPlatform,
  PrincipalSource,
} from "./auth-contracts.js";
import { BetterAuthModule } from "./auth-module.js";
import type { AuthLike } from "./auth-types.js";
import { nestjs } from "./plugin.js";

export function createTestAuth(
  options: BetterAuthOptions = {},
): ReturnType<typeof betterAuth> {
  const resolvedOptions = {
    secret: globalThis.crypto.randomUUID() + globalThis.crypto.randomUUID(),
    baseURL: "http://localhost:3000",
    emailAndPassword: { enabled: true },
    logger: { disabled: true },
    ...options,
    advanced: { ...options.advanced, disableOriginCheck: false },
    plugins: [...(options.plugins ?? []), nestjs()],
  } satisfies BetterAuthOptions;
  return betterAuth<BetterAuthOptions>({
    ...resolvedOptions,
    database:
      options.database ??
      memoryAdapter(
        Object.fromEntries(
          Object.values(getAuthTables(resolvedOptions)).map((table) => [
            table.modelName,
            [],
          ]),
        ),
      ),
  });
}
export async function createTestIdentity(
  auth: ReturnType<typeof createTestAuth>,
  emailSuffix = globalThis.crypto.randomUUID(),
): Promise<{ cookie: string; token: string; userId: string }> {
  const response = await auth.api.signUpEmail({
    body: {
      name: "Integration user",
      email: `${emailSuffix}@example.test`,
      password: "integration-test-password",
    },
    asResponse: true,
  });
  if (!response.ok) {
    throw new Error(`Test signup failed with status ${response.status}`);
  }
  const body = (await response.json()) as {
    token?: string;
    user?: { id?: string };
  };
  if (!body.token || !body.user?.id) {
    throw new Error("Test signup did not return a session token and user ID");
  }
  return {
    cookie: response.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; "),
    token: body.token,
    userId: body.user.id,
  };
}

export interface HttpFixture {
  readonly app: INestApplication;
  readonly url: string;
  close(): Promise<void>;
}
/**
 * Runtime options only. The fixture sets static and app options after spreading these, so a
 * static key here would be overwritten; typing those keys as never rejects them, including
 * through inferred variables that escape excess-property checks.
 */
type FixtureRuntimeOptions = Partial<BetterAuthRuntimeOptions<AuthLike>> & {
  readonly [K in keyof (BetterAuthStaticOptions &
    BetterAuthAppOptions)]?: never;
};
export async function startHttpFixture(options: {
  auth: AuthLike;
  adapter: AbstractHttpAdapter;
  platform: ExtensionRef<HttpPlatform>;
  controllers: readonly Type[];
  imports?: ModuleMetadata["imports"];
  transports?: readonly ExtensionRef<AuthTransport>[];
  principals?: readonly ExtensionRef<PrincipalSource>[];
  providers?: readonly Provider[];
  moduleOptions?: FixtureRuntimeOptions;
  configure?: (app: INestApplication) => void | Promise<void>;
}): Promise<HttpFixture> {
  const module = await Test.createTestingModule({
    imports: [
      BetterAuthModule.forRoot({
        ...options.moduleOptions,
        auth: options.auth,
        platforms: [options.platform],
        transports: options.transports,
        principals: options.principals,
      }),
      ...(options.imports ?? []),
    ],
    controllers: [...options.controllers],
    providers: [...(options.providers ?? [])],
  }).compile();
  const app = module.createNestApplication(options.adapter);
  try {
    await options.configure?.(app);
    await app.init();
    await app.listen(0, "127.0.0.1");
    return { app, url: await app.getUrl(), close: () => app.close() };
  } catch (error) {
    await app.close();
    throw error;
  }
}
