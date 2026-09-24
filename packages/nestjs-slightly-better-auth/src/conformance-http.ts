import assert from "node:assert/strict";
import { IncomingMessage } from "node:http";
import { connect } from "node:http2";
import { Socket } from "node:net";
import {
  Body,
  Catch,
  Controller,
  Get,
  Injectable,
  Module,
  Post,
  Req,
  RequestMethod,
  Res,
  UseGuards,
  UseInterceptors,
  VersioningType,
  type ArgumentsHost,
  type CallHandler,
  type CanActivate,
  type DynamicModule,
  type ExecutionContext,
  type INestApplication,
  type MiddlewareConsumer,
  type NestInterceptor,
  type NestModule,
  type Type,
} from "@nestjs/common";
import {
  APP_FILTER,
  BaseExceptionFilter,
  NestFactory,
  type AbstractHttpAdapter,
} from "@nestjs/core";
import { Test } from "@nestjs/testing";
import type { BetterAuthOptions } from "better-auth";
import { APIError, isAPIError } from "better-auth/api";
import type { Observable } from "rxjs";
import type {
  AuthHandlerInterceptor,
  BetterAuthRuntimeOptions,
  ExtensionRef,
  HttpPlatform,
  HttpRequestAccessor,
} from "./auth-contracts.js";
import {
  BeforeAuth,
  CurrentPrincipal,
  Public,
  RequireAuth,
} from "./auth-decorators.js";
import { isInfrastructureError } from "./auth-errors.js";
import { BetterAuthModule } from "./auth-module.js";
import { MOUNT_COORDINATOR } from "./auth-tokens.js";
import type { AuthHookContext, AuthLike, AuthPrincipal } from "./auth-types.js";
import {
  BRIDGE_HANDLE,
  type BridgeHandle,
  EXTENSION_DEFINITION,
} from "./bridge-protocol.js";
import {
  bootIssueCodes,
  CapturingLogger,
  type ConformanceCase,
  conformanceCase,
  conformanceSkip,
  type ConformanceOutcome,
  createConformanceAuth,
  KIT_BASE_URL,
  kitIdentity,
  probeOf,
  type ProbeState,
  type RawResponse,
  sendRaw,
  setCookieLines,
  settle,
} from "./conformance-fixtures.js";
import type { MountCoordinator } from "./mount-coordinator.js";

export interface HttpConformanceOptions {
  platform: ExtensionRef<HttpPlatform>;
  /** Fresh Nest HTTP adapter per app, e.g. () => new ExpressAdapter(). */
  createHttpAdapter(): AbstractHttpAdapter;
  /** Bootstraps to exercise. Default both. */
  bootstrap?: readonly ("factory" | "testing")[];
  /** Enable host CORS the platform's usual way. Default: app.enableCors({ origin, credentials: true }). */
  enableHostCors?(app: INestApplication, origin: string): void | Promise<void>;
  /** Configure trust in one forwarding hop the platform's usual way (for H-proxy-trust / H-url-trust-proxy). */
  trustOneProxy?(app: INestApplication): void | Promise<void>;
  /** HTTP/2 variant, required when the platform declares capabilities.http2. */
  http2?: { createHttpAdapter(): AbstractHttpAdapter };
  /** How to obtain a base URL. Default: app.listen(0) + getUrl(). */
  listen?(app: INestApplication): Promise<string>;
}

type Bootstrap = "factory" | "testing";
const AUTH = "/api/auth";
const CORS_ORIGIN = "https://app.example";
/** Makes the kit's `around` interceptor throw, so auth.handler rejects with a non-APIError. */
const THROW_HEADER = "x-conformance-throw";
const SDK_HEADERS = Symbol.for("better-call:api-error-headers");
const CANONICAL_413 = JSON.stringify({
  code: "PAYLOAD_TOO_LARGE",
  message: "Request body exceeds the configured limit",
});

interface BootConfig {
  auth?: Omit<BetterAuthOptions, "database">;
  module?: Partial<BetterAuthRuntimeOptions<AuthLike>>;
  async?: boolean;
  duplicateForRoot?: boolean;
  cors?: boolean;
  prefix?: string;
  versioning?: boolean;
  middleware?: boolean;
  http2?: boolean;
  trustProxy?: boolean;
}

interface AccessorObservation {
  guardKey?: object;
  interceptorKey?: object;
  handlerKey?: object;
  isRequest?: boolean;
  rejectsPlain?: boolean;
  rejectsUpgrade?: boolean;
  liveInHandler?: boolean;
  request?: unknown;
  sinkAppended?: boolean;
}

interface HttpBoot {
  readonly app: INestApplication;
  readonly url: string;
  readonly auth: AuthLike;
  readonly probe: ProbeState;
  readonly logger: CapturingLogger;
  readonly filtered: unknown[];
  readonly around: string[];
  readonly accessor: AccessorObservation;
  requests(): HttpRequestAccessor;
  close(): Promise<void>;
}

function resolvedPlatform(app: INestApplication): HttpPlatform {
  const coordinator = app.get<MountCoordinator>(MOUNT_COORDINATOR, {
    strict: false,
  });
  const platform = coordinator.platform;
  assert.ok(platform, "the application selected no HTTP platform");
  return platform;
}

/**
 * The capabilities a platform reference declares, when that is known without booting: a platform object without
 * `capabilities` declares none. Undefined means unknown (a class whose instances may set it, or a definition).
 */
function declaredCapabilities(
  ref: ExtensionRef<HttpPlatform>,
): HttpPlatform["capabilities"] | undefined {
  if (typeof ref === "function") {
    try {
      return (ref as unknown as { prototype: HttpPlatform }).prototype
        ?.capabilities;
    } catch {
      return undefined;
    }
  }
  if (ref && typeof ref === "object" && !(EXTENSION_DEFINITION in ref)) {
    return (ref as Partial<HttpPlatform>).capabilities ?? {};
  }
  return undefined;
}

/** true/false when a platform member is statically known, undefined for definitions. */
function staticMember(
  ref: ExtensionRef<HttpPlatform>,
  name: keyof HttpPlatform,
): boolean | undefined {
  if (typeof ref === "function") {
    return typeof Reflect.get(ref.prototype as object, name) === "function"
      ? true
      : undefined;
  }
  if (ref && typeof ref === "object" && !(EXTENSION_DEFINITION in ref)) {
    return typeof Reflect.get(ref, name) === "function";
  }
  return undefined;
}

async function capabilitiesOf(
  options: HttpConformanceOptions,
): Promise<HttpPlatform["capabilities"]> {
  const declared = declaredCapabilities(options.platform);
  if (declared) {
    return declared;
  }
  const boot = await bootHttp(options, "testing", {});
  try {
    return resolvedPlatform(boot.app).capabilities;
  } finally {
    await boot.close();
  }
}

function kitModule(
  options: HttpConformanceOptions,
  auth: AuthLike,
  probe: ProbeState,
  config: BootConfig,
  state: {
    filtered: unknown[];
    around: string[];
    accessor: AccessorObservation;
    requests(): HttpRequestAccessor;
    adapter(): AbstractHttpAdapter;
    /** Paths the kit's @BeforeAuth() hook provider saw. */
    hooks?: string[];
  },
): Type {
  const record: AuthHandlerInterceptor = async (call, next) => {
    state.around.push(
      `${call.request.method.toUpperCase()} ${new URL(call.request.url).pathname}`,
    );
    const failure = call.request.headers.get(THROW_HEADER);
    if (failure === "api-error") {
      const error = new APIError("BAD_REQUEST", {
        code: "CONFORMANCE_API_ERROR",
        message: "Conformance API error",
      });
      Object.defineProperty(error, SDK_HEADERS, {
        value: new Headers({ "set-cookie": "conformance_cleared=; Max-Age=0" }),
      });
      throw error;
    }
    if (failure) {
      throw new Error("conformance exchange failure");
    }
    return next();
  };
  const { http, ...runtime } = config.module ?? {};
  const moduleOptions = {
    logSummary: false,
    ...runtime,
    http: { ...http, around: [record, ...(http?.around ?? [])] },
  };
  const imports: DynamicModule[] = [];
  if (config.async) {
    const DEPENDENCY = Symbol("conformance-async-dependency");
    @Module({
      providers: [
        {
          provide: DEPENDENCY,
          useFactory: async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            return { auth };
          },
        },
      ],
      exports: [DEPENDENCY],
    })
    class AsyncDependencyModule {}
    imports.push(
      BetterAuthModule.forRootAsync({
        platforms: [options.platform],
        imports: [AsyncDependencyModule],
        inject: [DEPENDENCY],
        useFactory: async (dependency: { auth: AuthLike }) => ({
          ...moduleOptions,
          auth: dependency.auth,
        }),
      }),
    );
  } else {
    imports.push(
      BetterAuthModule.forRoot({
        ...moduleOptions,
        auth,
        platforms: [options.platform],
      } as never),
    );
  }
  if (config.duplicateForRoot) {
    imports.push(
      BetterAuthModule.forRoot({ auth, logSummary: false } as never),
    );
  }
  const guard: CanActivate = {
    canActivate(context: ExecutionContext) {
      state.accessor.guardKey = state
        .requests()
        .key(context.switchToHttp().getRequest());
      return true;
    },
  };
  const interceptor: NestInterceptor = {
    intercept(
      context: ExecutionContext,
      next: CallHandler,
    ): Observable<unknown> {
      state.accessor.interceptorKey = state
        .requests()
        .key(context.switchToHttp().getRequest());
      return next.handle();
    },
  };

  @Controller()
  class ConformanceAppController {
    @Public()
    @Post("app/echo")
    echo(@Body() body: unknown, @Req() request: { rawBody?: Buffer }) {
      return {
        body,
        rawBody: request.rawBody
          ? Buffer.from(request.rawBody).toString("utf8")
          : null,
      };
    }

    @Public()
    @Get("app/ping")
    ping() {
      return { pong: true };
    }

    @Public()
    @Get("api/auth/app-owned")
    owned() {
      return { owner: "app" };
    }

    @Get("app/me")
    me(@CurrentPrincipal() principal: AuthPrincipal | null) {
      return { userId: principal?.userId ?? null };
    }

    @RequireAuth({ authoritative: true })
    @Get("app/authoritative")
    authoritative(@CurrentPrincipal() principal: AuthPrincipal | null) {
      return { userId: principal?.userId ?? null };
    }

    @Public()
    @UseGuards(guard)
    @UseInterceptors(interceptor)
    @Get("app/accessor")
    accessor(
      @Req() request: unknown,
      @Res({ passthrough: true }) response: unknown,
    ) {
      const requests = state.requests();
      const observed = state.accessor;
      observed.handlerKey = requests.key(request);
      observed.isRequest = requests.isRequest(request);
      observed.rejectsPlain = !requests.isRequest({
        headers: { host: "localhost" },
        url: "/app/accessor",
        method: "GET",
      });
      observed.rejectsUpgrade = !requests.isRequest(
        new IncomingMessage(new Socket()),
      );
      observed.liveInHandler = requests.isLive(request);
      observed.request = request;
      observed.sinkAppended =
        requests
          .cookieSink(request, response)
          ?.append(["kit_sink=1; Path=/"]) ?? false;
      state
        .adapter()
        .appendHeader(response, "Set-Cookie", "kit_handler=1; Path=/");
      return { ok: true };
    }
  }

  @Injectable()
  class ConformanceHookProvider {
    @BeforeAuth("/probe/html")
    record(_context: AuthHookContext<"/probe/html">): void {
      state.hooks?.push("/probe/html");
    }
  }

  @Catch()
  class ConformanceRecordingFilter extends BaseExceptionFilter {
    override catch(exception: unknown, host: ArgumentsHost): void {
      state.filtered.push(exception);
      super.catch(exception, host);
    }
  }

  @Module({
    imports,
    controllers: [ConformanceAppController],
    providers: [
      ConformanceHookProvider,
      { provide: APP_FILTER, useClass: ConformanceRecordingFilter },
    ],
  })
  class ConformanceHttpModule implements NestModule {
    configure(consumer: MiddlewareConsumer): void {
      if (config.middleware) {
        consumer
          .apply((_request: unknown, _response: unknown, next: () => void) => {
            probe.order.push("middleware");
            next();
          })
          .forRoutes({ path: "*path", method: RequestMethod.ALL });
      }
    }
  }
  return ConformanceHttpModule;
}

async function bootHttp(
  options: HttpConformanceOptions,
  bootstrap: Bootstrap,
  config: BootConfig,
): Promise<HttpBoot> {
  const auth = createConformanceAuth(config.auth);
  const probe = await probeOf(auth);
  const logger = new CapturingLogger();
  const filtered: unknown[] = [];
  const around: string[] = [];
  const accessor: AccessorObservation = {};
  let application: INestApplication | undefined;
  const adapter = config.http2
    ? options.http2!.createHttpAdapter()
    : options.createHttpAdapter();
  const requests = () => resolvedPlatform(application!).requests;
  const module = kitModule(options, auth, probe, config, {
    filtered,
    around,
    accessor,
    requests,
    adapter: () => adapter,
  });
  const appOptions = { logger, rawBody: true, abortOnError: false };
  let app: INestApplication;
  if (bootstrap === "factory") {
    app = await NestFactory.create(module, adapter, appOptions);
  } else {
    const moduleRef = await Test.createTestingModule({
      imports: [module],
    }).compile();
    app = moduleRef.createNestApplication(adapter, appOptions);
  }
  application = app;
  try {
    if (config.cors) {
      if (options.enableHostCors) {
        await options.enableHostCors(app, CORS_ORIGIN);
      } else {
        app.enableCors({ origin: CORS_ORIGIN, credentials: true });
      }
    }
    if (config.prefix) {
      app.setGlobalPrefix(config.prefix);
    }
    if (config.versioning) {
      app.enableVersioning({ type: VersioningType.URI });
    }
    if (config.trustProxy) {
      assert.ok(options.trustOneProxy, "trustOneProxy is required here");
      await options.trustOneProxy(app);
    }
    await app.init();
    const url = await baseUrl(options, app);
    return {
      app,
      url,
      auth,
      probe,
      logger,
      filtered,
      around,
      accessor,
      requests,
      close: () => app.close(),
    };
  } catch (error) {
    await app.close().catch(() => undefined);
    throw error;
  }
}

/** The base URL of an initialized app: the `listen` option, or listen(0) and getUrl(), normalized. */
async function baseUrl(
  options: HttpConformanceOptions,
  app: INestApplication,
): Promise<string> {
  let url: string;
  if (options.listen) {
    url = await options.listen(app);
  } else {
    await app.listen(0, "127.0.0.1");
    url = await app.getUrl();
  }
  return url.replace("[::1]", "127.0.0.1").replace(/\/$/, "");
}

async function withBoot(
  options: HttpConformanceOptions,
  bootstrap: Bootstrap,
  config: BootConfig,
  fn: (boot: HttpBoot) => Promise<ConformanceOutcome>,
): Promise<ConformanceOutcome> {
  const boot = await bootHttp(options, bootstrap, config);
  try {
    return await fn(boot);
  } finally {
    await boot.close();
  }
}

function json(response: RawResponse): Record<string, unknown> {
  return JSON.parse(response.body.toString("utf8")) as Record<string, unknown>;
}

async function echo(
  boot: HttpBoot,
  body: Uint8Array | string | undefined,
  headers: Record<string, string>,
  chunks?: readonly (Uint8Array | string)[],
): Promise<{ bytes: Buffer; headers: Map<string, string>; status: number }> {
  const response = await sendRaw(`${boot.url}${AUTH}/probe/echo-raw`, {
    method: "POST",
    headers: { origin: KIT_BASE_URL, ...headers },
    body,
    chunks,
  });
  assert.equal(
    response.status,
    200,
    `echo-raw answered ${response.status}: ${response.body.toString("utf8")}`,
  );
  const value = json(response) as {
    body: string;
    headers: [string, string][];
  };
  return {
    status: response.status,
    bytes: Buffer.from(value.body, "base64"),
    headers: new Map(value.headers),
  };
}

function bodyCase(
  id: string,
  title: string,
  body: () => {
    bytes?: Uint8Array | string;
    chunks?: readonly (Uint8Array | string)[];
    contentType?: string;
    headers?: Record<string, string>;
  },
) {
  return async (options: HttpConformanceOptions, bootstrap: Bootstrap) =>
    withBoot(options, bootstrap, {}, async (boot) => {
      const input = body();
      const expected = Buffer.concat(
        (input.chunks ?? (input.bytes === undefined ? [] : [input.bytes])).map(
          (chunk) => Buffer.from(chunk),
        ),
      );
      const headers: Record<string, string> = { ...input.headers };
      if (input.contentType) {
        headers["content-type"] = input.contentType;
      }
      if (!input.chunks) {
        headers["content-length"] = String(expected.length);
      }
      const result = await echo(boot, input.bytes, headers, input.chunks);
      assert.deepEqual(
        [...result.bytes],
        [...expected],
        `${id}: ${title} bytes changed`,
      );
      assert.equal(
        result.headers.get("content-type") ?? null,
        input.contentType ?? null,
        `${id}: content-type changed`,
      );
    });
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 2_000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      assert.fail(message);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function http2Request(
  origin: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const session = connect(origin);
    const chunks: Buffer[] = [];
    let status = 0;
    const fail = (error: Error) => {
      session.close();
      reject(error);
    };
    session.once("error", fail);
    const stream = session.request(headers);
    stream.once("error", fail);
    stream.once("response", (received) => {
      status = Number(received[":status"] ?? 0);
    });
    stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    stream.once("end", () => {
      session.close();
      resolve({ status, body: Buffer.concat(chunks) });
    });
    stream.end(body);
  });
}

const multipartBoundary = "----conformance-boundary";
const multipartBody = [
  `--${multipartBoundary}\r\n`,
  'Content-Disposition: form-data; name="field"\r\n\r\n',
  "value  with  spaces\r\n",
  `--${multipartBoundary}\r\n`,
  'Content-Disposition: form-data; name="file"; filename="a.bin"\r\n',
  "Content-Type: application/octet-stream\r\n\r\n",
  "\u0000\u0001\u0002\r\n",
  `--${multipartBoundary}--\r\n`,
].join("");

type PerBootstrap = (
  options: HttpConformanceOptions,
  bootstrap: Bootstrap,
) => Promise<ConformanceOutcome>;

/**
 * The HTTP platform kit (invariants H1–H14). Each case boots a real Nest application per bootstrap with a real Better
 * Auth instance that includes conformanceProbePlugin(), an app controller, a @BeforeAuth() hook provider, a recording
 * global filter and an `around` recorder. HTTP/2 is required when the platform declares capabilities.http2; a platform
 * without the capability, or without the optional proxyTrust() or trustOneProxy, gets a skip with the reason: before
 * the run for platform objects, at run time for classes and definitions.
 */
export function httpPlatformConformance(
  options: HttpConformanceOptions,
): ConformanceCase[] {
  const bootstraps = options.bootstrap ?? ["factory", "testing"];
  const cases: ConformanceCase[] = [];
  const add = (
    id: string,
    title: string,
    run: PerBootstrap,
    only?: (bootstrap: Bootstrap) => string | undefined,
  ) => {
    for (const bootstrap of bootstraps) {
      cases.push(
        conformanceCase(
          id,
          `${title} [${bootstrap}]`,
          () => run(options, bootstrap),
          only?.(bootstrap),
        ),
      );
    }
  };

  add(
    "H-mount-methods",
    "every method under the base path reaches Better Auth",
    (o, b) =>
      withBoot(o, b, {}, async (boot) => {
        for (const method of [
          "GET",
          "POST",
          "PUT",
          "PATCH",
          "DELETE",
          "HEAD",
          "OPTIONS",
        ]) {
          await sendRaw(`${boot.url}${AUTH}/probe/echo-raw`, {
            method,
            headers: { origin: KIT_BASE_URL, "content-length": "0" },
          });
          assert.ok(
            boot.around.includes(`${method} ${AUTH}/probe/echo-raw`),
            `${method} did not reach the auth exchange (saw ${boot.around.join(", ")})`,
          );
        }
      }),
  );
  add(
    "H-mount-boundary",
    "the bare base path is mounted, /api/authx falls through, and other controllers work",
    (o, b) =>
      withBoot(o, b, {}, async (boot) => {
        await sendRaw(`${boot.url}${AUTH}`);
        assert.ok(
          boot.around.includes(`GET ${AUTH}`),
          "the bare base path did not reach Better Auth",
        );
        const adjacent = await sendRaw(`${boot.url}/api/authx`);
        assert.equal(adjacent.status, 404);
        assert.ok(
          !boot.around.some((entry) => entry.includes("/api/authx")),
          "/api/authx reached Better Auth",
        );
        const ping = await sendRaw(`${boot.url}/app/ping`);
        assert.equal(ping.status, 200);
        assert.deepEqual(json(ping), { pong: true });
      }),
  );
  add(
    "H-mount-custom-path",
    "basePath and baseURL paths mount there, unaffected by a global prefix and URI versioning",
    async (o, b) => {
      await withBoot(
        o,
        b,
        {
          auth: { basePath: "/custom/auth" },
          prefix: "v1",
          versioning: true,
        },
        async (boot) => {
          const response = await sendRaw(`${boot.url}/custom/auth/probe/html`);
          assert.equal(response.status, 200);
          assert.equal(response.body.toString("utf8"), "<p>probe</p>");
          const ping = await sendRaw(`${boot.url}/v1/app/ping`);
          assert.equal(ping.status, 200);
          const prefixed = await sendRaw(
            `${boot.url}/v1/custom/auth/probe/html`,
          );
          assert.notEqual(prefixed.status, 200);
        },
      );
      await withBoot(
        o,
        b,
        { auth: { baseURL: `${KIT_BASE_URL}/base/auth` } },
        async (boot) => {
          const response = await sendRaw(`${boot.url}/base/auth/probe/html`);
          assert.equal(response.status, 200);
        },
      );
    },
  );
  add(
    "H-app-route-precedence",
    "a controller route under the base path is served by Nest",
    (o, b) =>
      withBoot(o, b, {}, async (boot) => {
        const response = await sendRaw(`${boot.url}${AUTH}/app-owned`);
        assert.equal(response.status, 200);
        assert.deepEqual(json(response), { owner: "app" });
        assert.ok(
          !boot.around.some((entry) => entry.endsWith("/app-owned")),
          "Better Auth also saw the controller route",
        );
      }),
  );

  const bodies: [string, string, Parameters<typeof bodyCase>[2]][] = [
    [
      "H-body-json",
      "JSON with odd whitespace and key order",
      () => ({
        bytes: '{ "b" :1,\n\t"a":  [ 2 ,1 ] }  ',
        contentType: "application/json",
      }),
    ],
    [
      "H-body-utf8",
      "UTF-8 text",
      () => ({
        bytes: '{"name":"Zoë ✓ 認証 🔐"}',
        contentType: "application/json; charset=utf-8",
      }),
    ],
    [
      "H-body-urlencoded",
      "urlencoded b=%20x&c=1",
      () => ({
        bytes: "b=%20x&c=1",
        contentType: "application/x-www-form-urlencoded",
      }),
    ],
    [
      "H-body-text",
      "text/plain",
      () => ({ bytes: "plain  text\r\n", contentType: "text/plain" }),
    ],
    [
      "H-body-scim",
      "application/scim+json",
      () => ({
        bytes: '{"schemas":["urn:ietf:params:scim:api:messages:2.0:PatchOp"]}',
        contentType: "application/scim+json",
      }),
    ],
    [
      "H-body-multipart",
      "multipart/form-data",
      () => ({
        bytes: multipartBody,
        contentType: `multipart/form-data; boundary=${multipartBoundary}`,
      }),
    ],
    [
      "H-body-binary",
      "binary bytes 0x00-0xff",
      () => ({
        bytes: Uint8Array.from({ length: 256 }, (_, index) => index),
        contentType: "application/octet-stream",
      }),
    ],
    [
      "H-body-chunked",
      "a chunked transfer",
      () => ({
        chunks: ['{"part":', '"one",', '"two":2}'],
        contentType: "application/json",
      }),
    ],
    [
      "H-body-empty",
      "an empty body",
      () => ({ bytes: "", contentType: "application/json" }),
    ],
    [
      "H-body-no-content-type",
      "a body without content-type",
      () => ({ bytes: "raw-bytes" }),
    ],
  ];
  for (const [id, title, input] of bodies) {
    add(id, `${title} arrives byte-exact`, bodyCase(id, title, input));
  }
  add("H-body-form-sign-in", "a urlencoded sign-in succeeds", (o, b) =>
    withBoot(o, b, {}, async (boot) => {
      const identity = await kitIdentity(boot.auth, { password: true });
      const response = await sendRaw(`${boot.url}${AUTH}/sign-in/email`, {
        method: "POST",
        headers: {
          origin: KIT_BASE_URL,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          email: identity.email,
          password: identity.password!,
        }).toString(),
      });
      assert.equal(
        response.status,
        200,
        response.body.toString("utf8").slice(0, 200),
      );
      assert.ok(
        setCookieLines(response.headers).some((line) =>
          line.includes("session_token="),
        ),
        "the sign-in set no session cookie",
      );
    }),
  );

  const limited: BootConfig = {
    module: { http: { bodyLimit: 32 } },
    cors: true,
  };
  add(
    "H-limit-declared",
    "a declared over-limit body answers 413 with host CORS headers",
    (o, b) =>
      withBoot(o, b, limited, async (boot) => {
        const response = await sendRaw(`${boot.url}${AUTH}/probe/echo-raw`, {
          method: "POST",
          headers: {
            origin: CORS_ORIGIN,
            "content-type": "application/json",
            "content-length": "40",
          },
          body: "x".repeat(40),
        });
        assert.equal(response.status, 413);
        assert.equal(
          response.headers["access-control-allow-origin"],
          CORS_ORIGIN,
        );
        assert.equal(response.body.toString("utf8"), CANONICAL_413);
        assert.equal(boot.probe.order.length, 0, "Better Auth was called");
      }),
  );
  add(
    "H-limit-chunked",
    "a chunked over-limit body answers 413 with host CORS headers",
    (o, b) =>
      withBoot(o, b, limited, async (boot) => {
        const response = await sendRaw(`${boot.url}${AUTH}/probe/echo-raw`, {
          method: "POST",
          headers: { origin: CORS_ORIGIN, "content-type": "text/plain" },
          chunks: ["x".repeat(20), "y".repeat(20)],
        });
        assert.equal(response.status, 413);
        assert.equal(
          response.headers["access-control-allow-origin"],
          CORS_ORIGIN,
        );
        assert.equal(response.body.toString("utf8"), CANONICAL_413);
        assert.equal(boot.probe.order.length, 0, "Better Auth was called");
      }),
  );
  add(
    "H-limit-canonical-body",
    "the limit is exact and the 413 body is canonical",
    (o, b) =>
      withBoot(o, b, limited, async (boot) => {
        const exact = await sendRaw(`${boot.url}${AUTH}/probe/echo-raw`, {
          method: "POST",
          headers: {
            origin: KIT_BASE_URL,
            "content-type": "text/plain",
            "content-length": "32",
          },
          body: "z".repeat(32),
        });
        assert.equal(exact.status, 200, "a body at the limit was rejected");
        const over = await sendRaw(`${boot.url}${AUTH}/probe/echo-raw`, {
          method: "POST",
          headers: {
            origin: KIT_BASE_URL,
            "content-type": "text/plain",
            "content-length": "33",
          },
          body: "z".repeat(33),
        });
        assert.equal(over.status, 413);
        assert.equal(over.body.toString("utf8"), CANONICAL_413);
      }),
  );
  add("H-app-parsing", "app routes keep Nest body parsing", (o, b) =>
    withBoot(o, b, {}, async (boot) => {
      const response = await sendRaw(`${boot.url}/app/echo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"value":1}',
      });
      assert.equal(response.status, 201);
      assert.deepEqual(json(response).body, { value: 1 });
    }),
  );
  add("H-app-rawbody", "app routes keep rawBody", (o, b) =>
    withBoot(o, b, {}, async (boot) => {
      const raw = '{ "value" : 2 }';
      const response = await sendRaw(`${boot.url}/app/echo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: raw,
      });
      assert.equal(json(response).rawBody, raw);
    }),
  );
  add("H-url-query", "the query string reaches Better Auth unchanged", (o, b) =>
    withBoot(o, b, {}, async (boot) => {
      const path = `${AUTH}/probe/url?code=abc123&state=xyz%3D`;
      const response = await sendRaw(`${boot.url}${path}`);
      assert.equal(json(response).url, `${KIT_BASE_URL}${path}`);
    }),
  );
  add("H-url-encoded", "percent-encoding is preserved", (o, b) =>
    withBoot(o, b, {}, async (boot) => {
      const path = `${AUTH}/probe/url?next=%2Fa%20b%2Bc&mark=%E2%9C%93`;
      const response = await sendRaw(`${boot.url}${path}`);
      assert.equal(json(response).url, `${KIT_BASE_URL}${path}`);
    }),
  );
  add(
    "H-headers-passthrough",
    "browser, credential and content headers arrive unmodified",
    (o, b) =>
      withBoot(o, b, {}, async (boot) => {
        const headers = {
          origin: KIT_BASE_URL,
          referer: `${KIT_BASE_URL}/page?x=1`,
          "sec-fetch-site": "same-origin",
          "sec-fetch-mode": "cors",
          "sec-fetch-dest": "empty",
          cookie: "a=1; b=2",
          authorization: "Bearer conformance.token",
          "content-type": "application/json; charset=utf-8",
        };
        const result = await echo(boot, "{}", {
          ...headers,
          "content-length": "2",
        });
        for (const [name, value] of Object.entries(headers)) {
          assert.equal(result.headers.get(name), value, `${name} changed`);
        }
      }),
  );
  add(
    "H-ip-platform",
    "Better Auth's getIP sees the platform client IP",
    (o, b) =>
      withBoot(o, b, {}, async (boot) => {
        const response = await sendRaw(`${boot.url}${AUTH}/probe/ip`);
        assert.equal(json(response).ip, "127.0.0.1");
      }),
  );
  add("H-ip-spoof", "client-sent client-IP headers are ignored", (o, b) =>
    withBoot(o, b, {}, async (boot) => {
      const response = await sendRaw(`${boot.url}${AUTH}/probe/ip`, {
        headers: {
          "x-forwarded-for": "203.0.113.7",
          "x-real-ip": "203.0.113.8",
          [`x-nsba-ip-${"0".repeat(32)}`]: "203.0.113.9",
        },
      });
      const ip = json(response).ip;
      assert.ok(
        !["203.0.113.7", "203.0.113.8", "203.0.113.9"].includes(String(ip)),
        `a spoofed IP reached Better Auth: ${String(ip)}`,
      );
    }),
  );
  add(
    "H-proxy-trust",
    "proxyTrust() reports the effective setting before and after trustOneProxy",
    (o, b) =>
      withBoot(o, b, {}, async (boot) => {
        const platform = resolvedPlatform(boot.app);
        if (typeof platform.proxyTrust !== "function") {
          return conformanceSkip(
            "the platform does not implement the optional proxyTrust()",
          );
        }
        const adapter = boot.app.getHttpAdapter() as AbstractHttpAdapter;
        const before = platform.proxyTrust(adapter);
        await o.trustOneProxy!(boot.app);
        const after = platform.proxyTrust(adapter);
        if (before.mode === "unknown" || after.mode === "unknown") {
          assert.equal(
            before.mode,
            after.mode,
            "a platform that cannot inspect proxy trust must report unknown consistently",
          );
          return;
        }
        assert.notDeepEqual(
          after,
          before,
          "proxyTrust() did not reflect trustOneProxy",
        );
        assert.notEqual(after.mode, "none");
      }),
    () =>
      staticMember(options.platform, "proxyTrust") === false
        ? "the platform does not implement the optional proxyTrust()"
        : options.trustOneProxy
          ? undefined
          : "no trustOneProxy option was given",
  );
  const forwarded = {
    "x-forwarded-proto": "https",
    "x-forwarded-host": "proxy.example",
  };
  const derivedBaseUrl: BootConfig = {
    auth: { baseURL: undefined },
    module: { http: { allowRequestDerivedBaseURL: true } },
  };
  const probedUrl = async (boot: HttpBoot) =>
    new URL(
      String(
        json(
          await sendRaw(`${boot.url}${AUTH}/probe/url`, {
            headers: forwarded,
          }),
        ).url,
      ),
    );
  add(
    "H-url-trust-proxy",
    "untrusted forwarding headers leave the request URL unchanged",
    (o, b) =>
      withBoot(o, b, derivedBaseUrl, async (boot) => {
        const url = await probedUrl(boot);
        assert.notEqual(url.host, "proxy.example", "untrusted forwarding");
        assert.notEqual(url.protocol, "https:", "untrusted forwarding");
      }),
  );
  add(
    "H-url-trust-proxy",
    "a trusted forwarding hop sets the request URL's protocol and host",
    (o, b) =>
      withBoot(o, b, { ...derivedBaseUrl, trustProxy: true }, async (boot) => {
        assert.equal((await probedUrl(boot)).origin, "https://proxy.example");
      }),
    () =>
      options.trustOneProxy ? undefined : "no trustOneProxy option was given",
  );
  add(
    "H-h2-pseudo",
    "HTTP/2 pseudo-headers never reach Better Auth",
    async (o, b) => {
      const capabilities = await capabilitiesOf(o);
      if (!capabilities?.http2) {
        return conformanceSkip("the platform declares no http2 capability");
      }
      assert.ok(
        o.http2,
        "the platform declares capabilities.http2, so the kit requires the http2 option",
      );
      await withBoot(o, b, { http2: true }, async (boot) => {
        const origin = boot.url.replace(/^https?:/, "http:");
        const response = await http2Request(
          origin,
          {
            ":method": "POST",
            ":path": `${AUTH}/probe/echo-raw`,
            origin: KIT_BASE_URL,
            "content-type": "text/plain",
          },
          "h2 body",
        );
        assert.equal(response.status, 200);
        const value = JSON.parse(response.body.toString("utf8")) as {
          headers: [string, string][];
          body: string;
        };
        assert.equal(Buffer.from(value.body, "base64").toString(), "h2 body");
        assert.ok(
          value.headers.every(([name]) => !name.startsWith(":")),
          "pseudo-headers reached Better Auth",
        );
      });
    },
    () =>
      declaredCapabilities(options.platform) !== undefined &&
      !declaredCapabilities(options.platform)?.http2
        ? "the platform declares no http2 capability"
        : undefined,
  );
  add(
    "H-resp-multicookie",
    "three Set-Cookie values arrive on separate lines",
    (o, b) =>
      withBoot(o, b, {}, async (boot) => {
        const response = await sendRaw(`${boot.url}${AUTH}/probe/multi-cookie`);
        const lines = setCookieLines(response.headers);
        assert.equal(lines.length, 3, `Set-Cookie lines: ${lines.join(" | ")}`);
        assert.deepEqual(lines.map((line) => line.split("=", 1)[0]).sort(), [
          "probe_a",
          "probe_b",
          "probe_c",
        ]);
      }),
  );
  add(
    "H-resp-redirect",
    "a 302 with Location and a cookie is not followed",
    (o, b) =>
      withBoot(o, b, {}, async (boot) => {
        const response = await sendRaw(`${boot.url}${AUTH}/probe/redirect`);
        assert.equal(response.status, 302);
        assert.equal(
          response.headers.location,
          "https://probe-plugin.example/next",
        );
        assert.ok(
          setCookieLines(response.headers).some((line) =>
            line.startsWith("probe_redirect=1"),
          ),
        );
      }),
  );
  add(
    "H-resp-stream",
    "a three-chunk stream arrives in order and a client abort cancels it",
    (o, b) =>
      withBoot(o, b, {}, async (boot) => {
        const response = await sendRaw(`${boot.url}${AUTH}/probe/stream`);
        assert.equal(
          response.body.toString("utf8"),
          "chunk-0;chunk-1;chunk-2;",
        );
        boot.probe.streamCancelled = false;
        await sendRaw(`${boot.url}${AUTH}/probe/stream`, {
          abortAfterFirstChunk: true,
        });
        await waitFor(
          () => boot.probe.streamCancelled,
          "a client abort did not cancel the response stream",
        );
      }),
  );
  add("H-resp-head", "HEAD writes no body and never answers 500", (o, b) =>
    withBoot(o, b, {}, async (boot) => {
      const response = await sendRaw(`${boot.url}${AUTH}/probe/html`, {
        method: "HEAD",
      });
      assert.ok(response.status < 500, `HEAD answered ${response.status}`);
      assert.equal(response.body.length, 0);
    }),
  );
  add(
    "H-resp-status",
    "status, HTML and merged Vary pass through; a before-hook APIError becomes its response",
    (o, b) =>
      withBoot(o, b, { cors: true }, async (boot) => {
        const html = await sendRaw(`${boot.url}${AUTH}/probe/html`, {
          headers: { origin: CORS_ORIGIN },
        });
        assert.equal(html.status, 200);
        assert.match(String(html.headers["content-type"]), /^text\/html/);
        assert.equal(html.body.toString("utf8"), "<p>probe</p>");
        const tokens = (value: unknown) =>
          String(value ?? "")
            .toLowerCase()
            .split(",")
            .map((token) => token.trim())
            .filter(Boolean);
        const host = tokens(
          (
            await sendRaw(`${boot.url}/app/ping`, {
              headers: { origin: CORS_ORIGIN },
            })
          ).headers.vary,
        );
        const vary = tokens(html.headers.vary);
        for (const token of [...host, "accept"]) {
          assert.ok(
            vary.includes(token),
            `Vary lost ${token}: ${vary.join(", ")}`,
          );
        }
        const apiError = await sendRaw(
          `${boot.url}${AUTH}/probe/throw-api-error`,
        );
        assert.equal(apiError.status, 400);
        assert.equal(json(apiError).code, "PROBE_API_ERROR");
        boot.probe.fault = (path) =>
          path === "/probe/html"
            ? new APIError("FORBIDDEN", {
                code: "PROBE_DENIED",
                message: "denied",
              })
            : undefined;
        const denied = await sendRaw(`${boot.url}${AUTH}/probe/html`);
        assert.equal(denied.status, 403);
        assert.equal(json(denied).code, "PROBE_DENIED");
      }),
  );
  add(
    "H-cors-preflight",
    "host CORS answers the preflight before Better Auth",
    (o, b) =>
      withBoot(o, b, { cors: true }, async (boot) => {
        const response = await sendRaw(`${boot.url}${AUTH}/probe/put`, {
          method: "OPTIONS",
          headers: {
            origin: CORS_ORIGIN,
            "access-control-request-method": "PUT",
          },
        });
        assert.ok(response.status >= 200 && response.status < 300);
        assert.equal(
          response.headers["access-control-allow-origin"],
          CORS_ORIGIN,
        );
        assert.ok(
          !boot.around.some((entry) => entry.startsWith("OPTIONS")),
          "the preflight reached Better Auth",
        );
      }),
  );
  add("H-cors-actual", "host CORS adds its headers to auth responses", (o, b) =>
    withBoot(o, b, { cors: true }, async (boot) => {
      const response = await sendRaw(`${boot.url}${AUTH}/probe/html`, {
        headers: { origin: CORS_ORIGIN },
      });
      assert.equal(
        response.headers["access-control-allow-origin"],
        CORS_ORIGIN,
      );
      assert.equal(
        response.headers["access-control-allow-credentials"],
        "true",
      );
    }),
  );
  add(
    "H-accessor-key",
    "requests.key() is one object for guards, interceptors and handlers",
    (o, b) =>
      withBoot(o, b, {}, async (boot) => {
        const response = await sendRaw(`${boot.url}/app/accessor`);
        assert.equal(response.status, 200);
        const { guardKey, interceptorKey, handlerKey } = boot.accessor;
        assert.ok(guardKey && typeof guardKey === "object");
        assert.equal(guardKey, interceptorKey);
        assert.equal(guardKey, handlerKey);
      }),
  );
  add(
    "H-accessor-is-request",
    "isRequest() recognizes only platform requests and isLive() turns false after the response",
    (o, b) =>
      withBoot(o, b, {}, async (boot) => {
        await sendRaw(`${boot.url}/app/accessor`);
        const observed = boot.accessor;
        assert.equal(observed.isRequest, true);
        assert.equal(
          observed.rejectsPlain,
          true,
          "a plain object was accepted",
        );
        assert.equal(
          observed.rejectsUpgrade,
          true,
          "a bare IncomingMessage (upgrade request) was accepted",
        );
        assert.equal(observed.liveInHandler, true);
        await waitFor(
          () => !boot.requests().isLive(observed.request),
          "isLive() stayed true after the response was sent",
        );
      }),
  );
  add(
    "H-accessor-cookie-merge",
    "cookieSink() cookies arrive with the handler's own, and session reads leak no cache headers",
    (o, b) =>
      withBoot(o, b, {}, async (boot) => {
        const response = await sendRaw(`${boot.url}/app/accessor`);
        assert.equal(boot.accessor.sinkAppended, true);
        const names = setCookieLines(response.headers).map(
          (line) => line.split("=", 1)[0],
        );
        assert.ok(names.includes("kit_sink"), `cookies: ${names.join(",")}`);
        assert.ok(names.includes("kit_handler"), `cookies: ${names.join(",")}`);
        const identity = await kitIdentity(boot.auth);
        const me = await sendRaw(`${boot.url}/app/me`, {
          headers: { cookie: identity.cookie },
        });
        assert.equal(me.status, 200);
        assert.equal(json(me).userId, identity.userId);
        assert.equal(me.headers.pragma, undefined);
        assert.ok(
          !String(me.headers["cache-control"] ?? "").includes("no-store"),
          "getSession cache headers leaked onto an app route",
        );
      }),
  );
  add(
    "H-errors-infra",
    "a non-APIError from the exchange reaches the host pipeline as a 5xx",
    (o, b) =>
      withBoot(o, b, {}, async (boot) => {
        const response = await sendRaw(`${boot.url}${AUTH}/probe/html`, {
          headers: { [THROW_HEADER]: "1" },
        });
        assert.ok(response.status >= 500, `status ${response.status}`);
        assert.ok(
          boot.filtered.some(isInfrastructureError),
          "the global filter saw no infrastructure error",
        );
        assert.ok(boot.logger.errors().length > 0, "Nest logged no error");
      }),
  );
  add(
    "H-errors-filter-sees",
    "the global filter sees exchange failures with a global prefix set",
    (o, b) =>
      withBoot(o, b, { prefix: "v1" }, async (boot) => {
        const response = await sendRaw(`${boot.url}${AUTH}/probe/html`, {
          headers: { [THROW_HEADER]: "1" },
        });
        assert.ok(response.status >= 500);
        assert.ok(boot.filtered.some(isInfrastructureError));
      }),
  );
  add(
    "H-errors-apierror-throw",
    "with onAPIError.throw the filter receives the original APIError",
    (o, b) =>
      withBoot(
        o,
        b,
        { auth: { onAPIError: { throw: true } } },
        async (boot) => {
          await sendRaw(`${boot.url}${AUTH}/probe/html`, {
            headers: { [THROW_HEADER]: "api-error" },
          });
          const error = boot.filtered.find((value) => isAPIError(value)) as
            | { body?: { code?: string } }
            | undefined;
          assert.ok(error, "the filter did not receive the APIError");
          assert.equal(error.body?.code, "CONFORMANCE_API_ERROR");
          const hidden = Reflect.get(error, SDK_HEADERS) as Headers | undefined;
          assert.deepEqual(hidden?.getSetCookie(), [
            "conformance_cleared=; Max-Age=0",
          ]);
        },
      ),
  );
  add(
    "H-errors-no-hang",
    "failing endpoints, exchanges and interceptors complete within a timeout",
    (o, b) =>
      withBoot(o, b, {}, async (boot) => {
        const results = await Promise.all([
          sendRaw(`${boot.url}${AUTH}/probe/throw-error`, { timeoutMs: 3_000 }),
          sendRaw(`${boot.url}${AUTH}/probe/throw-api-error`, {
            timeoutMs: 3_000,
          }),
          sendRaw(`${boot.url}${AUTH}/probe/html`, {
            timeoutMs: 3_000,
            headers: { [THROW_HEADER]: "1" },
          }),
        ]);
        assert.ok(results.every((response) => response.status >= 400));
      }),
  );
  add(
    "H-middleware-order",
    "MiddlewareConsumer middleware runs before the auth handler",
    (o, b) =>
      withBoot(o, b, { middleware: true }, async (boot) => {
        await echo(boot, "{}", {
          "content-type": "application/json",
          "content-length": "2",
        });
        assert.deepEqual(boot.probe.order, ["middleware", "auth"]);
      }),
  );
  add(
    "H-async-options-factory",
    "a forRootAsync factory behind an async dependency still captures exact bytes",
    (o, b) =>
      withBoot(o, b, { async: true }, async (boot) => {
        const raw = '{  "spaced" :  true }';
        const result = await echo(boot, raw, {
          "content-type": "application/json",
          "content-length": String(raw.length),
        });
        assert.equal(result.bytes.toString("utf8"), raw);
      }),
  );
  add(
    "H-no-adapter",
    "application contexts and module init boot without an HTTP adapter",
    async (o) => {
      const auth = createConformanceAuth();
      const bridge = await bridgeOf(auth);
      const module = kitModule(
        o,
        auth,
        await probeOf(auth),
        {},
        {
          filtered: [],
          around: [],
          accessor: {},
          requests: () => assert.fail("no HTTP platform expected"),
          adapter: () => assert.fail("no HTTP adapter expected"),
        },
      );
      const context = await NestFactory.createApplicationContext(module, {
        logger: false,
        abortOnError: false,
      });
      await context.init();
      assert.equal(bridge.state, "bound");
      await context.close();
      assert.equal(bridge.state, "closed");
      const moduleRef = await Test.createTestingModule({
        imports: [module],
      }).compile();
      moduleRef.useLogger(false);
      await moduleRef.init();
      assert.equal(bridge.state, "bound");
      await moduleRef.close();
      assert.equal(bridge.state, "closed");
    },
  );
  add(
    "H-late-adapter",
    "module init followed by an application init fails with LATE_HTTP_ADAPTER",
    async (o) => {
      const auth = createConformanceAuth();
      const module = kitModule(
        o,
        auth,
        await probeOf(auth),
        {},
        {
          filtered: [],
          around: [],
          accessor: {},
          requests: () => assert.fail("unused"),
          adapter: () => assert.fail("unused"),
        },
      );
      const moduleRef = await Test.createTestingModule({
        imports: [module],
      }).compile();
      moduleRef.useLogger(false);
      try {
        await moduleRef.init();
        const app = moduleRef.createNestApplication(o.createHttpAdapter(), {
          logger: false,
        });
        const result = await settle(() => app.init());
        assert.equal(result.ok, false, "the late adapter was accepted");
        assert.ok(
          bootIssueCodes(!result.ok && result.error).includes(
            "LATE_HTTP_ADAPTER",
          ) || String(!result.ok && result.error).includes("LATE_HTTP_ADAPTER"),
          String(!result.ok && result.error),
        );
      } finally {
        await moduleRef.close();
      }
    },
  );
  add(
    "H-reused-testing-module",
    "a second application from one compiled TestingModule follows capabilities.prepareAtInit",
    async (o) => {
      const capabilities = await capabilitiesOf(o);
      const auth = createConformanceAuth();
      const around: string[] = [];
      const hooks: string[] = [];
      let current: INestApplication | undefined;
      const module = kitModule(
        o,
        auth,
        await probeOf(auth),
        {},
        {
          filtered: [],
          around,
          accessor: {},
          requests: () => resolvedPlatform(current!).requests,
          adapter: () => current!.getHttpAdapter() as AbstractHttpAdapter,
          hooks,
        },
      );
      const moduleRef = await Test.createTestingModule({
        imports: [module],
      }).compile();
      const first = moduleRef.createNestApplication(o.createHttpAdapter(), {
        logger: false,
      });
      current = first;
      await first.init();
      await first.close();
      const second = moduleRef.createNestApplication(o.createHttpAdapter(), {
        logger: false,
      });
      current = second;
      try {
        const result = await settle(() => second.init());
        if (!capabilities?.prepareAtInit) {
          assert.equal(result.ok, false, "the second application booted");
          assert.match(
            String(!result.ok && result.error),
            /APP_ADAPTER_CHANGED/,
          );
          return;
        }
        assert.equal(
          result.ok,
          true,
          `prepareAtInit platform failed: ${String(!result.ok && result.error)}`,
        );
        const url = await baseUrl(o, second);
        const before = hooks.length;
        const response = await sendRaw(`${url}${AUTH}/probe/html`);
        assert.equal(response.status, 200);
        assert.equal(
          hooks.length - before,
          1,
          "the second application did not run the @BeforeAuth() hook once",
        );
        const ping = await sendRaw(`${url}/app/ping`);
        assert.equal(ping.status, 200);
        const identity = await kitIdentity(auth);
        const authoritative = await sendRaw(`${url}/app/authoritative`, {
          headers: { cookie: identity.cookie },
        });
        assert.equal(
          authoritative.status,
          200,
          `the second application denied an authoritative route: ${authoritative.body.toString("utf8")}`,
        );
        assert.equal(json(authoritative).userId, identity.userId);
      } finally {
        await second.close().catch(() => undefined);
      }
    },
  );
  add(
    "H-double-forroot",
    "a second forRoot for the same instance fails boot",
    async (o, b) => {
      const result = await settle(() =>
        bootHttp(o, b, { duplicateForRoot: true }),
      );
      if (result.ok) {
        await result.value.close();
        assert.fail("a duplicate forRoot booted");
      }
      assert.ok(
        bootIssueCodes(result.error).includes("DUPLICATE_INSTANCE"),
        String(result.error),
      );
    },
  );
  add(
    "H-diagnostics-404",
    "an unknown auth path logs one WARN with a suggestion and keeps the 404",
    (o, b) =>
      withBoot(
        o,
        b,
        { module: { http: { diagnostics: true } } },
        async (boot) => {
          for (let index = 0; index < 2; index++) {
            const response = await sendRaw(
              `${boot.url}${AUTH}/sign-inn/email`,
              {
                method: "POST",
                headers: {
                  origin: KIT_BASE_URL,
                  "content-type": "application/json",
                },
                body: "{}",
              },
            );
            assert.equal(response.status, 404);
          }
          const warnings = boot.logger.entries.filter(
            (entry) =>
              entry.level === "warn" &&
              entry.text.includes(`${AUTH}/sign-inn/email`),
          );
          assert.equal(warnings.length, 1, boot.logger.text());
          assert.match(warnings[0]!.text, /Did you mean/);
        },
      ),
  );
  add(
    "H-log-hygiene",
    "session and probe cookies never appear in captured logs",
    (o, b) =>
      withBoot(o, b, {}, async (boot) => {
        const identity = await kitIdentity(boot.auth);
        const token = identity.cookie.split("=")[1]!.split(".")[0]!;
        await sendRaw(`${boot.url}${AUTH}/probe/multi-cookie`);
        await sendRaw(`${boot.url}${AUTH}/probe/throw-error`, {
          headers: { cookie: identity.cookie },
        });
        boot.probe.fault = () => new Error(`storage failed for ${token}`);
        await sendRaw(`${boot.url}/app/me`, {
          headers: { cookie: identity.cookie },
        });
        const text = boot.logger.text();
        assert.ok(!text.includes(token), "a session token reached the logs");
        assert.ok(!text.includes("gamma"), "a probe cookie reached the logs");
      }),
  );
  return cases;
}

async function bridgeOf(auth: AuthLike): Promise<BridgeHandle> {
  const context = (await auth.$context) as { getPlugin(id: string): unknown };
  const plugin = context.getPlugin("nestjs-slightly-better-auth") as object;
  return Reflect.get(plugin, BRIDGE_HANDLE) as BridgeHandle;
}
