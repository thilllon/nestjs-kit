// A consumer application compiled against the installed package tarball. The
// packaging tests compile it as ESM (.mts) and CommonJS (.cts), run it with
// Node and read the JSON line it prints. It avoids import.meta and top-level
// await so that one source serves both module formats.
import "reflect-metadata";
import {
  Controller,
  Get,
  Inject,
  type INestApplication,
  Module,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import {
  type AuthOf,
  type AuthUser,
  BetterAuthModule,
  BetterAuthService,
  CurrentUser,
  getBetterAuthServiceToken,
  UseAuthInstance,
} from "nestjs-slightly-better-auth";
import { expressPlatform } from "nestjs-slightly-better-auth/express";
import { nestjs } from "nestjs-slightly-better-auth/plugin";

const baseURL = "http://localhost:3000";
const secret = "packed-consumer-secret-with-enough-entropy-0123456789";

function database() {
  return memoryAdapter({
    user: [],
    session: [],
    account: [],
    verification: [],
  });
}

const auth = betterAuth({
  baseURL,
  secret,
  database: database(),
  emailAndPassword: { enabled: true },
  logger: { disabled: true },
  plugins: [nestjs()],
});

const adminAuth = betterAuth({
  baseURL,
  basePath: "/api/admin-auth",
  secret,
  database: database(),
  emailAndPassword: { enabled: true },
  advanced: { cookiePrefix: "admin-auth" },
  logger: { disabled: true },
  plugins: [nestjs()],
});

declare module "nestjs-slightly-better-auth" {
  interface Register {
    auth: typeof auth;
    instances: { admin: typeof adminAuth };
  }
}

@Controller("account")
class AccountController {
  constructor(
    @Inject(getBetterAuthServiceToken())
    private readonly service: BetterAuthService,
  ) {}

  @Get("profile")
  async profile(@CurrentUser() user: AuthUser) {
    const session = await this.service.getSession();
    return { email: user.email, serviceUser: session?.user.id === user.id };
  }
}

@UseAuthInstance("admin")
@Controller("admin")
class AdminController {
  constructor(
    @Inject(getBetterAuthServiceToken("admin"))
    private readonly service: BetterAuthService<AuthOf<"admin">>,
  ) {}

  @Get("me")
  async me(@CurrentUser() operator: AuthUser<"admin">) {
    const session = await this.service.getSession();
    return {
      email: operator.email,
      serviceUser: session?.user.id === operator.id,
    };
  }
}

@Module({
  imports: [
    BetterAuthModule.forRoot({
      auth,
      platforms: [expressPlatform()],
      logSummary: false,
    }),
    BetterAuthModule.forRoot({
      name: "admin",
      auth: adminAuth,
      logSummary: false,
    }),
  ],
  controllers: [AccountController, AdminController],
})
class AppModule {}

async function signUp(url: string, basePath: string, email: string) {
  const response = await fetch(`${url}${basePath}/sign-up/email`, {
    method: "POST",
    headers: { origin: baseURL, "content-type": "application/json" },
    body: JSON.stringify({ name: "Consumer", email, password: secret }),
  });
  const cookie = response.headers
    .getSetCookie()
    .map((line) => line.split(";")[0])
    .join("; ");
  return { status: response.status, cookie };
}

async function get(url: string, path: string, cookie?: string) {
  const response = await fetch(`${url}${path}`, {
    headers: cookie === undefined ? {} : { cookie },
  });
  const body: unknown = await response.json();
  return { status: response.status, body };
}

async function main() {
  const app: INestApplication = await NestFactory.create(
    AppModule,
    new ExpressAdapter(),
    { logger: false },
  );
  let closed = false;
  try {
    await app.listen(0, "127.0.0.1");
    const url = await app.getUrl();
    const user = await signUp(url, "/api/auth", "user@consumer.example");
    const operator = await signUp(
      url,
      "/api/admin-auth",
      "operator@consumer.example",
    );
    const services = {
      defaultAlias:
        app.get(BetterAuthService) === app.get(getBetterAuthServiceToken()),
      defaultInstance: app.get(BetterAuthService).instance === auth,
      namedInstance:
        app.get<BetterAuthService<AuthOf<"admin">>>(
          getBetterAuthServiceToken("admin"),
        ).instance === adminAuth,
    };
    const requests = {
      signUp: [user.status, operator.status],
      anonymous: (await get(url, "/account/profile")).status,
      user: await get(url, "/account/profile", user.cookie),
      operator: await get(url, "/admin/me", operator.cookie),
      crossDefault: (await get(url, "/account/profile", operator.cookie))
        .status,
      crossNamed: (await get(url, "/admin/me", user.cookie)).status,
    };
    await app.close();
    closed = true;
    console.log(JSON.stringify({ services, requests }));
  } finally {
    if (!closed) {
      await app.close();
    }
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
