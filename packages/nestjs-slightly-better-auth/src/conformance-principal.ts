import assert from "node:assert/strict";
import { inspect } from "node:util";
import {
  Body,
  ConsoleLogger,
  Controller,
  Inject,
  type INestApplication,
  Module,
  Post,
  Req,
  type Type,
} from "@nestjs/common";
import { type AbstractHttpAdapter, NestFactory } from "@nestjs/core";
import { Test, type TestingModule } from "@nestjs/testing";
import type { BetterAuthOptions } from "better-auth";
import { permission } from "./admin.js";
import type {
  AuthHandle,
  AuthorizationDecision,
  CookieSink,
  ExtensionRef,
  HttpPlatform,
  PrincipalRequest,
  PrincipalResolver,
  PrincipalResult,
  PrincipalSource,
  RequirementExpr,
  TransportCall,
} from "./auth-contracts.js";
import {
  AcceptPrincipals,
  ForwardAuthCookies,
  RequireAuth,
} from "./auth-decorators.js";
import {
  BetterAuthConfigurationError,
  getRawCause,
  isAuthFailure,
  isInfrastructureError,
} from "./auth-errors.js";
import { BetterAuthModule } from "./auth-module.js";
import { BetterAuthService } from "./auth-service.js";
import {
  getBetterAuthHandleToken,
  getExtensionToken,
  PRINCIPAL_RESOLVER,
} from "./auth-tokens.js";
import type {
  AdminPermissions,
  AuthLike,
  AuthPrincipal,
  PrincipalKind,
} from "./auth-types.js";
import {
  bootIssueCodes,
  type ConformanceCase,
  conformanceCase,
  conformanceSkip,
  type ConformanceOutcome,
  createConformanceAuth,
  KIT_BASE_URL,
  kitIdentity,
  PROBE_PLUGIN_ID,
  probeOf,
  type ProbeState,
  type RawResponse,
  sendRaw,
  setCookieLines,
  settle,
} from "./conformance-fixtures.js";
import { harness as policyHarness } from "./conformance-policy-harness.js";

/** An API key the kit's S-apikey-* cases created, and the request headers that present it. */
export interface ConformanceApiKey {
  /** The key's record id, which the kit uses to disable or expire the key through the database adapter. */
  readonly id: string;
  readonly headers: Headers;
}

/** Real HTTP delivery for the HTTP-route rows of S-cookie-forwarded and S-infra-throws and the cookie-bridge cases (S-bridge-*). */
export interface PrincipalHttpConformanceOptions {
  platform: ExtensionRef<HttpPlatform>;
  /** Fresh Nest HTTP adapter per app, e.g. () => new ExpressAdapter(). */
  createHttpAdapter(): AbstractHttpAdapter;
  /** How to obtain a base URL. Default: app.listen(0, '127.0.0.1') + getUrl(). */
  listen?(app: INestApplication): Promise<string>;
}

export interface PrincipalSourceConformanceOptions {
  /**
   * The source under test. Pass a factory reference (defineExtension({ use: { useFactory } })) when the source keeps
   * per-instance state across requests, such as the API-key outage probe or a JWT key cache: every case boots its
   * own module, and a factory gives each case a fresh source.
   */
  source: ExtensionRef<PrincipalSource>;
  /**
   * The Better Auth instance the credentials belong to. It must include conformanceProbePlugin(), testUtils() and
   * nestjs(), with session.updateAge 0 and session refresh enabled, so every session read produces a refresh
   * Set-Cookie: createConformanceAuth({ plugins }) builds one. The kit fails with CONFORMANCE_SESSION_REFRESH otherwise.
   */
  auth: AuthLike;
  credentials: {
    /**
     * A fresh valid credential of `auth`: the options' instance, or a variant() instance (S-dynamic-base-url). Variant
     * instances have a dynamic baseURL without fallback that allows localhost:3000 (the kit base URL's host) and
     * public.example, so an auth.api call that creates the credential must pass headers with one of those hosts.
     */
    valid(auth: AuthLike): Promise<Headers>;
    invalid(): Headers;
    rateLimited?(auth: AuthLike): Promise<Headers>;
    /**
     * S-apikey-*: creates a key with these extra createApiKey body fields (remaining, rateLimitEnabled, ...).
     * Default: a key of a new kit user through auth.api.createApiKey, presented in the source's first credential header.
     */
    apiKey?(
      auth: AuthLike,
      fields: Readonly<Record<string, unknown>>,
    ): Promise<ConformanceApiKey>;
    /** S-apikey-org-key: an organization-owned key (references: 'organization'). The case skips without it. */
    organizationKey?(auth: AuthLike): Promise<Headers>;
  };
  /**
   * S-dynamic-base-url: another instance of the same configuration with the kit's overrides (a dynamic baseURL,
   * trusted proxy headers). Default: createConformanceAuth({ ...overrides, plugins }) with the plugins of `auth`
   * other than the kit's own; pass variant() when those plugin objects keep per-instance state.
   */
  variant?(overrides: Omit<BetterAuthOptions, "database">): AuthLike;
  /**
   * Boots a guarded route and the cookie-bridge routes on this HTTP platform for the HTTP-route rows of
   * S-cookie-forwarded and S-infra-throws and for S-bridge-*. Those cases skip without it.
   */
  http?: PrincipalHttpConformanceOptions;
}

interface ResolveInit {
  freshness?: "default" | "authoritative";
  /** Shared by the calls of one logical request, as the resolver's per-request memo is. */
  memo?: Map<unknown, Promise<unknown>>;
}

interface Harness {
  readonly auth: AuthLike;
  readonly source: PrincipalSource;
  readonly handle: AuthHandle;
  readonly probe: ProbeState;
  /** The source alone, inside the resolver's chain scope. */
  resolve(
    headers: Headers,
    cookies: CookieSink | null,
    init?: ResolveInit,
  ): Promise<PrincipalResult>;
  /** The real principal resolver, with its error normalization and redaction. */
  resolveChain(
    headers: Headers,
    cookies: CookieSink | null,
  ): Promise<PrincipalResult>;
  close(): Promise<void>;
}

interface HarnessInit {
  /** Another instance than options.auth (a variant). */
  auth?: AuthLike;
  /** Extra BetterAuthModule.forRoot options. */
  module?: Record<string, unknown>;
}

class RecordingSink implements CookieSink {
  readonly values: string[] = [];

  append(setCookies: readonly string[]): boolean {
    this.values.push(...setCookies);
    return true;
  }
}

async function assertKitInstance(auth: AuthLike): Promise<ProbeState> {
  const probe = await probeOf(auth);
  const session = (
    (await auth.$context) as {
      options: {
        session?: { updateAge?: number; disableSessionRefresh?: boolean };
      };
    }
  ).options.session;
  if (session?.updateAge !== 0 || session.disableSessionRefresh) {
    throw new BetterAuthConfigurationError(
      "CONFORMANCE_SESSION_REFRESH",
      "The principal-source kit needs session.updateAge 0 with session refresh enabled, so that every session read produces a refresh Set-Cookie.",
      "Create the instance with createConformanceAuth() or set session: { updateAge: 0 }.",
    );
  }
  return probe;
}

function kitModule(
  auth: AuthLike,
  source: ExtensionRef<PrincipalSource>,
  module: Record<string, unknown> = {},
) {
  return BetterAuthModule.forRoot({
    auth,
    principals: [source],
    session: false,
    http: { mount: false },
    logSummary: false,
    ...module,
  } as never);
}

async function harness(
  options: PrincipalSourceConformanceOptions,
  init: HarnessInit = {},
): Promise<Harness> {
  const auth = init.auth ?? options.auth;
  const probe = await assertKitInstance(auth);
  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [kitModule(auth, options.source, init.module)],
  }).compile();
  moduleRef.useLogger(false);
  try {
    await moduleRef.init();
  } catch (error) {
    await moduleRef.close().catch(() => undefined);
    throw error;
  }
  const handle = moduleRef.get<AuthHandle>(getBetterAuthHandleToken());
  const source = moduleRef.get<PrincipalSource>(
    getExtensionToken("principals", "default", 0),
  );
  const resolver = moduleRef.get<PrincipalResolver>(PRINCIPAL_RESOLVER);
  return {
    auth,
    source,
    handle,
    probe,
    resolve(headers, cookies, resolveInit = {}) {
      const memo = resolveInit.memo ?? new Map<unknown, Promise<unknown>>();
      const request: PrincipalRequest = {
        headers,
        cookies,
        transport: "conformance",
        freshness: resolveInit.freshness ?? "default",
        auth: handle,
        memo<T>(key: unknown, compute: () => Promise<T>): Promise<T> {
          if (!memo.has(key)) {
            memo.set(key, compute());
          }
          return memo.get(key) as Promise<T>;
        },
      };
      // The same chain scope the resolver establishes: same-credential forwarding, library-internal calls.
      return handle.run(
        {
          cookies,
          forward: "same-credential",
          inbound: () => headers,
          internal: true,
        },
        async () => {
          if (source.appliesTo && !source.appliesTo(request)) {
            return { outcome: "absent" } as const;
          }
          return source.resolve(request);
        },
      );
    },
    resolveChain(headers, cookies) {
      const key = {};
      const call: TransportCall = {
        key,
        invocation: key,
        headers: () => new Headers(headers),
        clientIp: null,
        cookies,
        param: () => undefined,
      };
      return resolver.resolve(call, {
        auth: handle,
        freshness: "default",
        accepts: new Set<string>(source.kinds),
        sourceSet: "nestjs-slightly-better-auth:principal-conformance",
      });
    },
    close: () => moduleRef.close(),
  };
}

async function withHarness(
  options: PrincipalSourceConformanceOptions,
  fn: (harness: Harness) => Promise<ConformanceOutcome>,
  init: HarnessInit = {},
): Promise<ConformanceOutcome> {
  const value = await harness(options, init);
  try {
    return await fn(value);
  } finally {
    value.probe.fault = undefined;
    value.probe.storageFault = undefined;
    value.probe.storageDelay = undefined;
    value.probe.respond = undefined;
    await value.close();
  }
}

function names(cookies: readonly string[]): string[] {
  return cookies.map((line) => line.split("=", 1)[0]!);
}

function cookieValue(header: string | null | undefined, name: string): string {
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) {
      return part.slice(index + 1).trim();
    }
  }
  return "";
}

/** The request's credential as the cookie bridge compares it: session cookie, Authorization and declared headers. */
function credentialOf(
  headers: Headers | undefined,
  sessionCookie: string,
  extra: readonly string[],
): string {
  return [
    cookieValue(headers?.get("cookie"), sessionCookie),
    headers?.get("authorization") ?? "",
    ...extra.map((name) => headers?.get(name) ?? ""),
  ].join("\u0000");
}

/** Set-Cookie lines that calls with the request's own credential, or with none, produced since `from`. */
function ownCookies(
  probe: ProbeState,
  from: number,
  request: Headers,
  extra: readonly string[],
): string[] {
  return probe.produced.slice(from).flatMap((entry) => {
    const call = credentialOf(entry.headers, entry.sessionCookie, extra);
    return call === credentialOf(request, entry.sessionCookie, extra) ||
      call === credentialOf(undefined, entry.sessionCookie, extra)
      ? entry.setCookies
      : [];
  });
}

function occurrences(lines: readonly string[], line: string): number {
  return lines.filter((value) => value === line).length;
}

const KIT_HOST = new URL(KIT_BASE_URL).host;
const PUBLIC_HOST = "public.example";
/** Hosts a variant instance's dynamic baseURL allows. */
const DYNAMIC_HOSTS = [KIT_HOST, PUBLIC_HOST];
/** How long S-apikey-outage stalls the key's usage update, above apiKeyPrincipal()'s default slowMs of 500. */
const STALL_MS = 750;
const READ_ONLY = "cannot execute UPDATE in a read-only transaction";
const WRITES = new Set([
  "create",
  "update",
  "updateMany",
  "delete",
  "deleteMany",
]);
/** The kit's own plugins, which createConformanceAuth() adds to every instance it builds. */
const KIT_PLUGINS = new Set([
  "test-utils",
  "bearer",
  PROBE_PLUGIN_ID,
  "nestjs-slightly-better-auth",
]);

function variantOf(
  options: PrincipalSourceConformanceOptions,
  overrides: Omit<BetterAuthOptions, "database">,
): Promise<AuthLike> {
  if (options.variant) {
    return Promise.resolve(options.variant(overrides));
  }
  return (async () => {
    const context = (await options.auth.$context) as {
      options: { plugins?: { id: string }[] };
    };
    const plugins = (context.options.plugins ?? []).filter(
      (plugin) => !KIT_PLUGINS.has(plugin.id),
    );
    return createConformanceAuth({
      ...overrides,
      plugins: plugins as never,
    });
  })();
}

/** Judges one principal against a requirement through the policy kit's real-evaluator harness. */
async function judgePrincipal(
  auth: AuthLike,
  requirement: RequirementExpr,
  principal: AuthPrincipal,
): Promise<{ decision: AuthorizationDecision; evaluations: number }> {
  const value = await policyHarness({ auth, requirement });
  try {
    const decision = await value.decide(principal);
    return { decision, evaluations: value.invocations.count };
  } finally {
    await value.close();
  }
}

/** A source that verifies keys of the Better Auth api-key plugin (the S-apikey-* cases). */
function verifiesApiKeys(source: PrincipalSource): boolean {
  return (
    (source.kinds as readonly string[]).includes("api-key") &&
    (source.requires?.plugins ?? []).includes("api-key")
  );
}

const NOT_API_KEY = "the source does not verify keys of the api-key plugin";

interface KeyApi {
  createApiKey(input: {
    body: Record<string, unknown>;
  }): Promise<{ id: string; key: string }>;
  verifyApiKey(input: unknown): Promise<unknown>;
}

async function createKey(
  options: PrincipalSourceConformanceOptions,
  harness: Harness,
  fields: Readonly<Record<string, unknown>> = {},
): Promise<ConformanceApiKey> {
  if (options.credentials.apiKey) {
    return options.credentials.apiKey(harness.auth, fields);
  }
  const owner = await kitIdentity(harness.auth);
  const created = await (harness.auth.api as unknown as KeyApi).createApiKey({
    body: { userId: owner.userId, ...fields },
  });
  return {
    id: created.id,
    headers: new Headers({
      [harness.source.credentialHeaders?.[0] ?? "x-api-key"]: created.key,
    }),
  };
}

async function updateKey(
  harness: Harness,
  id: string,
  update: Record<string, unknown>,
): Promise<void> {
  const context = (await harness.auth.$context) as {
    adapter: {
      update(input: {
        model: string;
        where: { field: string; value: unknown }[];
        update: Record<string, unknown>;
      }): Promise<unknown>;
    };
  };
  await context.adapter.update({
    model: "apikey",
    where: [{ field: "id", value: id }],
    update,
  });
}

/** An unknown key in the source's credential header, unique per call so no cache answers it. */
function unknownKey(source: PrincipalSource): Headers {
  return new Headers({
    [source.credentialHeaders?.[0] ?? "x-api-key"]:
      `conformance-unknown-${globalThis.crypto.randomUUID()}`,
  });
}

function assertRejected(
  result: PrincipalResult,
  status: number,
  reason: string,
  label: string,
): void {
  assert.equal(
    result.outcome,
    "rejected",
    `${label} resolved ${JSON.stringify(result)}`,
  );
  const failure = result.outcome === "rejected" ? result.failure : undefined;
  assert.equal(failure?.status, status, `${label}: ${JSON.stringify(failure)}`);
  assert.equal(failure?.reason, reason, `${label}: ${JSON.stringify(failure)}`);
}

async function assertInfrastructure(
  run: () => Promise<PrincipalResult>,
  label: string,
): Promise<void> {
  const result = await settle(run);
  assert.equal(
    result.ok,
    false,
    `${label} resolved ${JSON.stringify(result.ok && result.value)} instead of an infrastructure error`,
  );
  assert.ok(
    !isAuthFailure(!result.ok && result.error),
    `${label} was thrown as a denial: ${String(!result.ok && result.error)}`,
  );
}

/** Every form of the credentials a request presents: cookie values (signed, decoded, raw token), bearer, headers. */
function credentialForms(
  headers: Headers,
  credentialHeaders: readonly string[],
): string[] {
  const forms = new Set<string>();
  const add = (value: string | null | undefined) => {
    if (value && value.length >= 8) {
      forms.add(value);
    }
  };
  for (const part of (headers.get("cookie") ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) {
      continue;
    }
    const value = part.slice(index + 1).trim();
    add(value);
    let decoded = value;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      // Keep the raw form.
    }
    add(decoded);
    const dot = decoded.lastIndexOf(".");
    if (dot > 0) {
      add(decoded.slice(0, dot));
    }
  }
  const authorization = headers.get("authorization");
  add(authorization);
  add(/^\S+\s+(.+)$/.exec(authorization ?? "")?.[1]);
  for (const name of credentialHeaders) {
    if (name !== "cookie" && name !== "authorization") {
      add(headers.get(name));
    }
  }
  return [...forms];
}

/** Raw session token of the instance's session cookie in a request, or undefined. */
async function sessionToken(
  auth: AuthLike,
  headers: Headers,
): Promise<{ name: string; token: string } | undefined> {
  const context = (await auth.$context) as {
    authCookies: { sessionToken: { name: string } };
  };
  const name = context.authCookies.sessionToken.name;
  const value = decodeURIComponent(cookieValue(headers.get("cookie"), name));
  const dot = value.lastIndexOf(".");
  return dot > 0 ? { name, token: value.slice(0, dot) } : undefined;
}

/** A plain-object rendering of an error, as JSON loggers serialize one: own properties, message, stack and causes. */
function serializeError(value: unknown, depth = 0): unknown {
  if (!(value instanceof Error) || depth > 8) {
    return value;
  }
  const output: Record<string, unknown> = {
    ...Object.fromEntries(Object.entries(value)),
    name: value.name,
    message: value.message,
    stack: value.stack,
  };
  if (value.cause !== undefined) {
    output.cause = serializeError(value.cause, depth + 1);
  }
  return output;
}

/** What Nest's ConsoleLogger writes for an error, in text and JSON mode. */
function consoleLogged(error: Error): string {
  const chunks: string[] = [];
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  const record = (chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  };
  process.stdout.write = record as typeof process.stdout.write;
  process.stderr.write = record as typeof process.stderr.write;
  try {
    const text = new ConsoleLogger("S-log-redaction", { colors: false });
    text.error(error);
    text.error(error.message, error.stack);
    new ConsoleLogger("S-log-redaction", { json: true }).error(error);
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
  return chunks.join("");
}

const BRIDGE_PATH = "nestjs-slightly-better-auth-principal-conformance";

interface BridgeBoot {
  readonly url: string;
  readonly origin: string;
  post(
    path: string,
    headers: Headers,
    body?: Record<string, unknown>,
  ): Promise<RawResponse>;
  close(): Promise<void>;
}

function bridgeController(kinds: readonly string[]): Type {
  @Controller(BRIDGE_PATH)
  class PrincipalBridgeController {
    constructor(
      @Inject(BetterAuthService) private readonly service: BetterAuthService,
    ) {}

    @Post("principal")
    principal() {
      return { ok: true };
    }

    @Post("sign-up")
    signUp() {
      return this.signUpAnother();
    }

    @ForwardAuthCookies()
    @Post("sign-up-forwarded")
    signUpForwarded() {
      return this.signUpAnother();
    }

    @ForwardAuthCookies()
    @Post("foreign-session")
    async foreignSession(@Body() body: { token: string }) {
      await this.foreignRead(body.token);
      return { ok: true };
    }

    @ForwardAuthCookies()
    @Post("foreign-forwarded")
    async foreignForwarded(@Body() body: { token: string }) {
      await this.service.forwardForeignCookies(() =>
        this.foreignRead(body.token),
      );
      return { ok: true };
    }

    @Post("foreign-undeclared")
    async foreignUndeclared(@Body() body: { token: string }) {
      try {
        await this.service.forwardForeignCookies(() =>
          this.foreignRead(body.token),
        );
        return { code: null };
      } catch (error) {
        return { code: (error as { code?: unknown }).code ?? null };
      }
    }

    @ForwardAuthCookies()
    @Post("sign-out")
    async signOut(@Req() request: unknown) {
      await (
        this.service.api as unknown as {
          signOut(input: { headers: Headers }): Promise<unknown>;
        }
      ).signOut({ headers: this.service.headersFrom(request) });
      return { ok: true };
    }

    private async signUpAnother() {
      const result = await (
        this.service.api as unknown as {
          signUpEmail(input: {
            body: { email: string; password: string; name: string };
          }): Promise<{ token: string | null }>;
        }
      ).signUpEmail({
        body: {
          email: `${globalThis.crypto.randomUUID()}@conformance.example`,
          password: `pw-${globalThis.crypto.randomUUID()}`,
          name: "Conformance third party",
        },
      });
      return { token: result.token };
    }

    private foreignRead(token: string) {
      return (
        this.service.api as unknown as {
          getSession(input: { headers: Headers }): Promise<unknown>;
        }
      ).getSession({
        headers: new Headers({ authorization: `Bearer ${token}` }),
      });
    }
  }
  RequireAuth()(PrincipalBridgeController);
  AcceptPrincipals(
    ...(kinds as readonly string[] as [PrincipalKind, ...PrincipalKind[]]),
  )(PrincipalBridgeController);
  return PrincipalBridgeController;
}

async function bootBridge(
  options: PrincipalSourceConformanceOptions,
  http: PrincipalHttpConformanceOptions,
  kinds: readonly string[],
): Promise<BridgeBoot> {
  const controller = bridgeController(kinds);
  const auth = options.auth;
  const imports = [
    BetterAuthModule.forRoot({
      auth,
      principals: [options.source],
      session: false,
      platforms: [http.platform],
      http: { mount: false },
      logSummary: false,
    } as never),
  ];
  @Module({
    imports,
    controllers: [controller],
  })
  class PrincipalBridgeModule {}
  const app = await NestFactory.create(
    PrincipalBridgeModule,
    http.createHttpAdapter(),
    { logger: false, abortOnError: false },
  );
  try {
    await app.init();
    let url: string;
    if (http.listen) {
      url = await http.listen(app);
    } else {
      await app.listen(0, "127.0.0.1");
      url = await app.getUrl();
    }
    url = url.replace("[::1]", "127.0.0.1").replace(/\/$/, "");
    const context = (await auth.$context) as { baseURL: string };
    const origin = new URL(context.baseURL || KIT_BASE_URL).origin;
    return {
      url,
      origin,
      post(path, headers, body = {}) {
        const outgoing: Record<string, string> = {};
        headers.forEach((value, name) => {
          outgoing[name] = value;
        });
        return sendRaw(`${url}/${BRIDGE_PATH}/${path}`, {
          method: "POST",
          headers: {
            ...outgoing,
            origin,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        });
      },
      close: () => app.close(),
    };
  } catch (error) {
    await app.close().catch(() => undefined);
    throw error;
  }
}

function json(response: RawResponse): Record<string, unknown> {
  return JSON.parse(response.body.toString("utf8") || "{}") as Record<
    string,
    unknown
  >;
}

/** Set-Cookie lines of a response that carry this raw session token. */
function linesWithToken(response: RawResponse, token: string): string[] {
  return setCookieLines(response.headers).filter((line) =>
    decodeURIComponent(line.split(";", 1)[0]!).includes(`=${token}.`),
  );
}

/**
 * The principal-source kit (invariants P1–P7 and the unit-specific rows of design v7 §14.1). It resolves the source
 * directly inside the resolver's chain scope, so a source that throws for invalid credentials fails
 * S-rejected-not-thrown although core would normalize the throw at runtime; S-log-redaction resolves through the real
 * principal resolver. Storage faults are injected into the instance's database adapter, below every endpoint and
 * every direct adapter read, so endpoints that swallow storage errors are exercised too. A case that does not apply to
 * the source (an API-key row for a session source, say) skips with the reason.
 */
export function principalSourceConformance(
  options: PrincipalSourceConformanceOptions,
): ConformanceCase[] {
  const add = (
    id: string,
    title: string,
    run: (harness: Harness) => Promise<ConformanceOutcome>,
    skip?: string,
  ) => conformanceCase(id, title, () => withHarness(options, run), skip);
  const valid = (harness: Harness) => options.credentials.valid(harness.auth);
  return [
    add(
      "S-rejected-not-thrown",
      "invalid credentials resolve rejected with 401, 403 or 429 and never throw",
      async ({ resolve, source }) => {
        const result = await settle(() =>
          resolve(options.credentials.invalid(), new RecordingSink()),
        );
        assert.equal(
          result.ok,
          true,
          `resolve threw for an invalid credential: ${String(!result.ok && result.error)}`,
        );
        const value = result.ok ? result.value : undefined;
        // Better Auth answers an unreadable session cookie as "no session"; session-backed sources mirror it.
        if (value?.outcome === "absent" && source.sessionBacked) {
          return;
        }
        assert.equal(value?.outcome, "rejected");
        const failure =
          value?.outcome === "rejected" ? value.failure : undefined;
        assert.ok(
          isAuthFailure(failure),
          "the rejection is not an AuthFailure",
        );
        assert.ok([401, 403, 429].includes(failure.status));
      },
    ),
    add(
      "S-infra-throws",
      "a storage outage makes resolve throw instead of denying",
      async (harness) => {
        const { resolve, probe } = harness;
        const headers = await valid(harness);
        const calls = probe.calls.length;
        const storage = probe.storage.length;
        probe.storageFault = () => new Error("conformance storage outage");
        const result = await settle(() =>
          resolve(headers, new RecordingSink()),
        );
        probe.storageFault = undefined;
        if (probe.calls.length === calls && probe.storage.length === storage) {
          return conformanceSkip(
            "the source read no storage and called no Better Auth endpoint for a valid credential",
          );
        }
        assert.equal(
          result.ok,
          false,
          `a storage outage resolved ${JSON.stringify(result.ok && result.value)}`,
        );
        assert.ok(
          !isAuthFailure(!result.ok && result.error),
          `a storage outage was thrown as a denial: ${String(!result.ok && result.error)}`,
        );
      },
    ),
    add(
      "S-cookie-forwarded",
      "Set-Cookie lines of the source's own-credential calls reach the sink exactly once",
      async (harness) => {
        const { resolve, probe, source } = harness;
        const sink = new RecordingSink();
        const headers = await valid(harness);
        const from = probe.produced.length;
        const result = await resolve(new Headers(headers), sink);
        assert.equal(result.outcome, "authenticated");
        const produced = ownCookies(
          probe,
          from,
          headers,
          source.credentialHeaders ?? [],
        );
        for (const line of new Set(produced)) {
          assert.equal(
            occurrences(sink.values, line),
            occurrences(produced, line),
            `the source's Better Auth calls produced ${occurrences(produced, line)} × ${names([line])[0]}, the sink received ${occurrences(sink.values, line)} (sink: ${names(sink.values).join(", ") || "nothing"})`,
          );
        }
        const seen = names(sink.values);
        assert.deepEqual(
          seen,
          [...new Set(seen)],
          `a cookie was delivered twice: ${seen.join(", ")}`,
        );
      },
    ),
    add(
      "S-refresh-suppressed",
      "resolving without a cookie sink refreshes nothing",
      async (harness) => {
        const { resolve, probe } = harness;
        const headers = await valid(harness);
        const writes = probe.writes.length;
        const refresh = probe.refresh.length;
        const result = await resolve(headers, null);
        assert.equal(result.outcome, "authenticated");
        assert.ok(
          !probe.writes.slice(writes).includes("session.update"),
          "a session row was refreshed",
        );
        assert.ok(
          probe.refresh.slice(refresh).every((entry) => entry.skip),
          "a Better Auth call ran without refresh suppression",
        );
      },
    ),
    add(
      "S-absent-clean",
      "no credential resolves absent without cookies or writes",
      async ({ resolve, probe }) => {
        const sink = new RecordingSink();
        const writes = probe.writes.length;
        const result = await resolve(new Headers(), sink);
        assert.equal(result.outcome, "absent");
        assert.deepEqual(sink.values, []);
        assert.deepEqual(probe.writes.slice(writes), []);
      },
    ),
    add(
      "S-shape",
      "an authenticated principal names its kind, source and user",
      async (harness) => {
        const { resolve, source } = harness;
        const result = await resolve(await valid(harness), new RecordingSink());
        assert.equal(result.outcome, "authenticated");
        const principal =
          result.outcome === "authenticated" ? result.principal : undefined;
        assert.ok(principal);
        assert.ok((source.kinds as readonly string[]).includes(principal.kind));
        assert.equal(principal.source, source.id);
        assert.ok(
          principal.userId === null || typeof principal.userId === "string",
        );
      },
    ),
    add(
      "S-credential-headers",
      "a valid credential without its declared headers resolves absent",
      async (harness) => {
        const { resolve, source } = harness;
        const headers = await valid(harness);
        for (const name of source.credentialHeaders ?? []) {
          headers.delete(name);
        }
        const result = await resolve(headers, new RecordingSink());
        assert.equal(
          result.outcome,
          "absent",
          "the source read a credential from an undeclared header",
        );
      },
    ),
    add(
      "S-session-backed",
      "sessionBacked is declared exactly when the principal is Better Auth's session read",
      async (harness) => {
        const { resolve, source, handle } = harness;
        const getSession = (headers: Headers) =>
          (
            handle.api as {
              getSession(input: { headers: Headers }): Promise<unknown>;
            }
          ).getSession({ headers });
        for (const headers of [
          await valid(harness),
          options.credentials.invalid(),
        ]) {
          const session = await getSession(new Headers(headers)).catch(
            () => null,
          );
          const result = await resolve(new Headers(headers), null);
          if (source.sessionBacked) {
            assert.equal(
              result.outcome === "authenticated",
              session !== null,
              "a sessionBacked source disagrees with getSession",
            );
          } else if (result.outcome === "authenticated") {
            assert.equal(
              session,
              null,
              "the credential is a Better Auth session; declare sessionBacked",
            );
          }
        }
      },
    ),
    add(
      "S-delegation",
      "delegation is present exactly when the source declares delegates",
      async (harness) => {
        const { resolve, source } = harness;
        const result = await resolve(await valid(harness), new RecordingSink());
        assert.equal(result.outcome, "authenticated");
        const principal =
          result.outcome === "authenticated" ? result.principal : undefined;
        assert.equal(
          Boolean(principal?.delegation),
          Boolean(source.delegates),
          "delegates does not match the produced principals",
        );
        if (principal?.delegation) {
          assert.equal(typeof principal.delegation.allows, "function");
          assert.equal(typeof principal.delegation.description, "string");
          assert.equal(
            typeof principal.delegation.allows({ conformance: ["probe"] }),
            "boolean",
          );
        }
      },
    ),
    add(
      "S-rate-limited",
      "a rate-limited credential resolves rejected 429",
      async (harness) => {
        const result = await harness.resolve(
          await options.credentials.rateLimited!(harness.auth),
          new RecordingSink(),
        );
        assert.equal(result.outcome, "rejected");
        const failure =
          result.outcome === "rejected" ? result.failure : undefined;
        assert.equal(failure?.status, 429);
      },
      options.credentials.rateLimited
        ? undefined
        : "the options give no rateLimited() credential",
    ),
    ...dynamicBaseUrlCases(options),
    ...apiKeyCases(options, add),
    add(
      "S-short-circuit-session",
      "a before hook's short-circuited session is a default-freshness principal and never authoritative",
      async (harness) => {
        const { resolve, probe, source } = harness;
        if (!source.sessionBacked) {
          return conformanceSkip("the source is not session-backed");
        }
        const headers = await valid(harness);
        const userId = `conformance-short-circuit-${globalThis.crypto.randomUUID()}`;
        const now = new Date();
        probe.respond = (path) =>
          path === "/get-session"
            ? {
                user: {
                  id: userId,
                  email: `${userId}@conformance.example`,
                  emailVerified: false,
                  name: "Conformance short-circuit",
                  createdAt: now,
                  updatedAt: now,
                },
                session: {
                  id: `${userId}-session`,
                  userId,
                  token: `${userId}-token`,
                  expiresAt: new Date(now.getTime() + 3_600_000),
                  createdAt: now,
                  updatedAt: now,
                },
              }
            : undefined;
        const calls = probe.calls.length;
        // A cookie sink: the transport is cookie-capable, as HTTP is.
        const fresh = await settle(() =>
          resolve(new Headers(headers), new RecordingSink()),
        );
        assert.ok(
          probe.calls.slice(calls).includes("/get-session"),
          "the source did not read the session through /get-session",
        );
        assert.equal(
          fresh.ok,
          true,
          `a short-circuited session read threw: ${String(!fresh.ok && fresh.error)}`,
        );
        const value = fresh.ok ? fresh.value : undefined;
        assert.equal(
          value?.outcome,
          "authenticated",
          `a default-freshness read of a short-circuited session resolved ${JSON.stringify(value)}`,
        );
        assert.equal(
          value?.outcome === "authenticated" ? value.principal.userId : null,
          userId,
          "the principal is not the short-circuited session's user",
        );
        const authoritative = await settle(() =>
          resolve(new Headers(headers), new RecordingSink(), {
            freshness: "authoritative",
          }),
        );
        assert.equal(
          authoritative.ok,
          true,
          `an authoritative read threw: ${String(!authoritative.ok && authoritative.error)}`,
        );
        const decided = authoritative.ok ? authoritative.value : undefined;
        assert.notEqual(
          decided?.outcome,
          "authenticated",
          "an authoritative route accepted a session no endpoint produced",
        );
        if (decided?.outcome === "rejected") {
          assert.equal(decided.failure.status, 401);
        }
      },
    ),
    ...bridgeCases(options),
    ...httpRouteCases(options),
    ...logRedactionCases(options),
    ...jwtCases(options),
  ];
}

function logRedactionCases(
  options: PrincipalSourceConformanceOptions,
): ConformanceCase[] {
  /** One run: every credential form of the requests in the outage error, resolved through the real resolver. */
  const run = (exposeRawCause: boolean) =>
    withHarness(
      options,
      async (value) => {
        const headers = await options.credentials.valid(value.auth);
        const requests = [headers];
        const session = await sessionToken(value.auth, headers);
        if (value.source.sessionBacked && session) {
          requests.push(
            new Headers({ authorization: `Bearer ${session.token}` }),
          );
        }
        let observed = false;
        // Better Auth endpoints may swallow an adapter error into a generic one, so the error also comes from a
        // before hook, which rethrows it unchanged: both reach the library's error path.
        const modes = ["storage", "endpoint"] as const;
        for (const request of requests) {
          const secrets = credentialForms(
            request,
            value.source.credentialHeaders ?? [],
          );
          const outage = () => {
            const error = new Error(
              `conformance outage for ${secrets.join(" ")}`,
            );
            Object.assign(error, { detail: secrets.join(" ") });
            error.cause = new Error(`nested ${secrets.join(" ")}`);
            return error;
          };
          for (const mode of modes) {
            const inject = () => {
              if (mode === "storage") {
                value.probe.storageFault = outage;
              } else {
                value.probe.fault = outage;
              }
            };
            inject();
            const chained = await settle(() =>
              value.resolveChain(new Headers(request), new RecordingSink()),
            );
            inject();
            const direct = await settle(() =>
              value.resolve(new Headers(request), new RecordingSink()),
            );
            value.probe.storageFault = undefined;
            value.probe.fault = undefined;
            if (chained.ok) {
              continue;
            }
            observed = true;
            const error = chained.error;
            assert.ok(
              isInfrastructureError(error),
              `a ${mode} outage surfaced as ${String(error)}`,
            );
            const logs = [
              consoleLogged(error),
              JSON.stringify(serializeError(error)),
              // The raw cause is a hidden property by design when the instance opts in.
              inspect(error, { depth: 8, showHidden: !exposeRawCause }),
            ].join("\n");
            for (const secret of secrets) {
              assert.ok(
                !logs.includes(secret),
                `a credential reached the logs after a ${mode} outage (exposeRawCause: ${exposeRawCause}): ${secret.slice(0, 6)}…`,
              );
            }
            const raw = getRawCause(error);
            if (!exposeRawCause) {
              assert.equal(
                raw,
                undefined,
                "getRawCause exposed a cause without errors.exposeRawCause",
              );
            } else if (!direct.ok && !isInfrastructureError(direct.error)) {
              // The source let the error escape; the resolver wraps it and keeps it for the opt-in.
              assert.ok(
                raw instanceof Error &&
                  raw.message === (direct.error as Error | undefined)?.message,
                `errors.exposeRawCause did not keep the escaped raw cause: ${String(raw)}`,
              );
            }
          }
        }
        return observed
          ? undefined
          : conformanceSkip(
              "the source read no storage and called no Better Auth endpoint for a valid credential, so no error reached it",
            );
      },
      { module: { errors: { exposeRawCause } } },
    );
  return [
    conformanceCase(
      "S-log-redaction",
      "a storage error carrying the request's credentials leaves none in Nest ConsoleLogger or JSON logs",
      () => run(false),
    ),
    conformanceCase(
      "S-log-redaction",
      "with errors.exposeRawCause the logs stay redacted and getRawCause keeps an escaped raw cause",
      () => run(true),
    ),
  ];
}

function dynamicBaseUrlCases(
  options: PrincipalSourceConformanceOptions,
): ConformanceCase[] {
  const dynamic = { baseURL: { allowedHosts: DYNAMIC_HOSTS } };
  return [
    conformanceCase(
      "S-dynamic-base-url",
      "a dynamic baseURL without fallback fails boot for hostless sources and never answers 500 for the others",
      async () => {
        const auth = await variantOf(options, dynamic as never);
        // A misconfigured variant fails the case; only the source's boot errors skip it.
        await assertKitInstance(auth);
        const booted = await settle(() => harness(options, { auth }));
        if (!booted.ok) {
          const codes = bootIssueCodes(booted.error);
          if (codes.includes("DYNAMIC_BASE_URL_WITHOUT_FALLBACK")) {
            return;
          }
          if (!codes.length) {
            throw booted.error;
          }
          return conformanceSkip(
            `the source rejects a dynamic baseURL without fallback at boot (${codes.filter((code) => code !== "AUTH_BOOT_FAILED").join(", ")})`,
          );
        }
        const value = booted.value;
        try {
          assert.ok(
            !value.source.requires?.hostlessCalls,
            "a source that declares requires.hostlessCalls booted with a dynamic baseURL and no fallback",
          );
          const host = { host: KIT_HOST };
          const requests: [string, Headers][] = [
            ["valid", await options.credentials.valid(auth)],
            ["invalid", options.credentials.invalid()],
          ];
          for (const [label, credential] of requests) {
            const headers = new Headers(credential);
            headers.set("host", host.host);
            const result = await settle(() =>
              value.resolve(headers, new RecordingSink()),
            );
            assert.equal(
              result.ok,
              true,
              `the ${label} credential threw with a dynamic baseURL (a hostless call?): ${String(!result.ok && result.error)}`,
            );
          }
        } finally {
          await value.close();
        }
      },
    ),
    conformanceCase(
      "S-dynamic-base-url",
      "behind a trusted proxy, the forwarded public host resolves the dynamic baseURL",
      async () => {
        const auth = await variantOf(options, {
          ...dynamic,
          advanced: { trustedProxyHeaders: true },
        } as never);
        // A misconfigured variant fails the case; only the source's boot errors skip it.
        await assertKitInstance(auth);
        const booted = await settle(() => harness(options, { auth }));
        if (!booted.ok) {
          const codes = bootIssueCodes(booted.error);
          if (!codes.length) {
            throw booted.error;
          }
          return conformanceSkip(
            `the source rejects a dynamic baseURL without fallback at boot (${codes.filter((code) => code !== "AUTH_BOOT_FAILED").join(", ")})`,
          );
        }
        const value = booted.value;
        try {
          const headers = new Headers(await options.credentials.valid(auth));
          // The app's own host is not allowed; only the forwarded public host is.
          headers.set("host", "nest-app:3000");
          headers.set("x-forwarded-host", PUBLIC_HOST);
          headers.set("x-forwarded-proto", "https");
          const result = await settle(() =>
            value.resolve(headers, new RecordingSink()),
          );
          assert.equal(
            result.ok,
            true,
            `a forwarded request threw with a dynamic baseURL: ${String(!result.ok && result.error)}`,
          );
        } finally {
          await value.close();
        }
      },
    ),
  ];
}

function apiKeyCases(
  options: PrincipalSourceConformanceOptions,
  add: (
    id: string,
    title: string,
    run: (harness: Harness) => Promise<ConformanceOutcome>,
  ) => ConformanceCase,
): ConformanceCase[] {
  const apiKeyCase = (
    id: string,
    title: string,
    run: (harness: Harness) => Promise<ConformanceOutcome>,
  ) =>
    add(id, title, (harness) =>
      verifiesApiKeys(harness.source)
        ? run(harness)
        : Promise.resolve(conformanceSkip(NOT_API_KEY)),
    );
  return [
    apiKeyCase(
      "S-apikey-results",
      "rate-limited, exhausted, disabled, expired and unknown keys map to their statuses, one verification per request",
      async (harness) => {
        const { resolve, source } = harness;
        const limited = await createKey(options, harness, {
          rateLimitEnabled: true,
          rateLimitMax: 1,
          rateLimitTimeWindow: 60_000,
        });
        assert.equal(
          (await resolve(new Headers(limited.headers), null)).outcome,
          "authenticated",
          "the rate-limited key's first request did not authenticate",
        );
        const throttled = await resolve(new Headers(limited.headers), null);
        assertRejected(throttled, 429, "RATE_LIMITED", "a rate-limited key");
        const retryAfter = Number(
          throttled.outcome === "rejected"
            ? throttled.failure.headers?.get("retry-after")
            : undefined,
        );
        assert.ok(
          retryAfter >= 50 && retryAfter <= 60,
          `Retry-After ${retryAfter} does not come from the 60 s window's tryAgainIn`,
        );
        const exhausted = await createKey(options, harness, { remaining: 0 });
        assertRejected(
          await resolve(exhausted.headers, null),
          429,
          "USAGE_EXCEEDED",
          "an exhausted key",
        );
        const disabled = await createKey(options, harness);
        await updateKey(harness, disabled.id, { enabled: false });
        assertRejected(
          await resolve(disabled.headers, null),
          401,
          "KEY_DISABLED",
          "a disabled key",
        );
        const expired = await createKey(options, harness);
        await updateKey(harness, expired.id, {
          expiresAt: new Date(Date.now() - 60_000),
        });
        assertRejected(
          await resolve(expired.headers, null),
          401,
          "KEY_EXPIRED",
          "an expired key",
        );
        assertRejected(
          await resolve(unknownKey(source), null),
          401,
          "INVALID_API_KEY",
          "an unknown key",
        );
        const api = harness.auth.api as unknown as KeyApi;
        const verify = api.verifyApiKey;
        let verifications = 0;
        api.verifyApiKey = (input) => {
          verifications++;
          return verify.call(api, input);
        };
        try {
          const key = await createKey(options, harness);
          const memo = new Map<unknown, Promise<unknown>>();
          for (const freshness of [
            "default",
            "default",
            "authoritative",
          ] as const) {
            assert.equal(
              (
                await resolve(new Headers(key.headers), null, {
                  freshness,
                  memo,
                })
              ).outcome,
              "authenticated",
            );
          }
        } finally {
          api.verifyApiKey = verify;
        }
        assert.equal(
          verifications,
          1,
          `one request verified its key ${verifications} times`,
        );
      },
    ),
    apiKeyCase(
      "S-apikey-outage",
      "a flood of invalid keys runs at most one outage probe",
      async ({ resolve, probe, source }) => {
        const from = probe.storage.length;
        const results = await Promise.all(
          Array.from({ length: 12 }, () => resolve(unknownKey(source), null)),
        );
        for (const result of results) {
          assertRejected(result, 401, "INVALID_API_KEY", "an unknown key");
        }
        const writes = probe.storage
          .slice(from)
          .filter((entry) => WRITES.has(entry.split(":", 1)[0]!));
        assert.ok(
          writes.length <= 1,
          `a flood of 12 invalid keys wrote ${writes.length} times (${writes.join(", ")}); the outage probe runs at most once per second`,
        );
      },
    ),
    apiKeyCase(
      "S-apikey-outage",
      "with key reads failing, an API-key request answers 5xx instead of 401",
      async (harness) => {
        const { resolve, probe, source } = harness;
        const key = await createKey(options, harness);
        probe.storageFault = (call) =>
          call.method === "findOne"
            ? new Error("conformance read outage")
            : undefined;
        await assertInfrastructure(
          () => resolve(unknownKey(source), null),
          "an unknown key during a read outage",
        );
        await assertInfrastructure(
          () => resolve(new Headers(key.headers), null),
          "a valid key during a read outage",
        );
      },
    ),
    apiKeyCase(
      "S-apikey-outage",
      "a stalled, failing usage update answers 5xx while an unknown key still answers a fast 401",
      async (harness) => {
        const { resolve, probe, source } = harness;
        const key = await createKey(options, harness);
        const usage = (call: { method: string; model: string | undefined }) =>
          call.method === "update" && call.model === "apikey";
        probe.storageDelay = (call) => (usage(call) ? STALL_MS : undefined);
        probe.storageFault = (call) =>
          usage(call) ? new Error("conformance stalled update") : undefined;
        await assertInfrastructure(
          () => resolve(new Headers(key.headers), null),
          "a valid key whose usage update stalled and failed",
        );
        const started = performance.now();
        const unknown = await resolve(unknownKey(source), null);
        const elapsed = performance.now() - started;
        assertRejected(unknown, 401, "INVALID_API_KEY", "an unknown key");
        assert.ok(
          elapsed < STALL_MS,
          `an unknown key took ${Math.round(elapsed)} ms, no faster than the stalled update`,
        );
      },
    ),
    apiKeyCase(
      "S-apikey-write-outage",
      "with reads succeeding and every write failing, a valid key answers 5xx, not 401",
      async (harness) => {
        const { resolve, probe } = harness;
        const key = await createKey(options, harness);
        probe.storageFault = (call) =>
          WRITES.has(call.method) ? new Error(READ_ONLY) : undefined;
        await assertInfrastructure(
          () => resolve(new Headers(key.headers), null),
          "a valid key during a write outage",
        );
      },
    ),
    apiKeyCase(
      "S-apikey-write-outage",
      "the outage probe's write changes no key row",
      async (harness) => {
        const { resolve, source } = harness;
        await createKey(options, harness);
        const context = (await harness.auth.$context) as {
          adapter: { findMany(input: { model: string }): Promise<unknown[]> };
        };
        const before = JSON.stringify(
          await context.adapter.findMany({ model: "apikey" }),
        );
        assertRejected(
          await resolve(unknownKey(source), null),
          401,
          "INVALID_API_KEY",
          "an unknown key",
        );
        assert.equal(
          JSON.stringify(await context.adapter.findMany({ model: "apikey" })),
          before,
          "an invalid key changed a stored key",
        );
      },
    ),
    conformanceCase(
      "S-apikey-org-key",
      "an organization-owned key has no user and is denied by user-scoped admin permissions",
      async () => {
        let principal: AuthPrincipal | undefined;
        const outcome = await withHarness(options, async (harness) => {
          if (!verifiesApiKeys(harness.source)) {
            return conformanceSkip(NOT_API_KEY);
          }
          if (!(await harness.handle.hasPlugin("admin"))) {
            return conformanceSkip("the instance has no admin() plugin");
          }
          const result = await harness.resolve(
            await options.credentials.organizationKey!(harness.auth),
            null,
          );
          assert.equal(
            result.outcome,
            "authenticated",
            `the organization key resolved ${JSON.stringify(result)}`,
          );
          principal =
            result.outcome === "authenticated" ? result.principal : undefined;
          const key = principal as
            | (AuthPrincipal & { organizationId?: unknown })
            | undefined;
          assert.equal(
            key?.userId,
            null,
            "an organization-owned key produced a user principal",
          );
          assert.ok(
            typeof key?.organizationId === "string" &&
              key.organizationId.length > 0,
            "an organization-owned key carries no organizationId",
          );
        });
        if (outcome && typeof outcome.skipped === "string") {
          return outcome;
        }
        // The kit judges the instance under test, not the program's registered instance, whose
        // admin() statements type permission() and may name other resources.
        const permissions = { user: ["list"] } as Readonly<
          Record<string, readonly string[]>
        > as AdminPermissions;
        const optedIn = await judgePrincipal(
          options.auth,
          permission(permissions, { principals: ["session", "api-key"] }),
          principal!,
        );
        assert.equal(optedIn.decision.effect, "deny");
        assert.equal(
          (optedIn.decision as { reason?: string }).reason,
          "USER_REQUIRED",
          JSON.stringify(optedIn.decision),
        );
        assert.equal(
          (optedIn.decision as { status?: number }).status ?? 403,
          403,
        );
        const gated = await judgePrincipal(
          options.auth,
          permission(permissions),
          principal!,
        );
        assert.equal(gated.decision.effect, "deny");
        assert.equal(
          (gated.decision as { reason?: string }).reason,
          "PRINCIPAL_NOT_SUPPORTED",
          JSON.stringify(gated.decision),
        );
        assert.equal(
          gated.evaluations,
          0,
          "the default permission() ran its policy for an API-key principal",
        );
      },
      options.credentials.organizationKey
        ? undefined
        : "the options give no organizationKey() credential",
    ),
  ];
}

function bridgeCases(
  options: PrincipalSourceConformanceOptions,
): ConformanceCase[] {
  const skip = options.http ? undefined : "the options give no http harness";
  /** Boots the bridge app for a session-backed source whose credential carries the session cookie. */
  const withBridge = async (
    fn: (boot: BridgeBoot, caller: () => Promise<Headers>) => Promise<void>,
  ): Promise<ConformanceOutcome> => {
    const inspected = await harness(options);
    const { source } = inspected;
    let credential: Headers;
    try {
      credential = await options.credentials.valid(options.auth);
    } finally {
      await inspected.close();
    }
    if (!source.sessionBacked) {
      return conformanceSkip("the source is not session-backed");
    }
    if (!(await sessionToken(options.auth, credential))) {
      return conformanceSkip(
        "the valid credential carries no session cookie of the instance",
      );
    }
    const boot = await bootBridge(options, options.http!, source.kinds);
    try {
      await fn(boot, () => options.credentials.valid(options.auth));
    } finally {
      await boot.close();
    }
  };
  return [
    conformanceCase(
      "S-bridge-third-party-signup",
      "a direct sign-up for another user leaves the caller's cookies untouched unless the handler forwards",
      () =>
        withBridge(async (boot, caller) => {
          const headers = await caller();
          const own = (await sessionToken(options.auth, headers))!;
          const plain = await boot.post("sign-up", headers);
          assert.equal(plain.status, 201, plain.body.toString("utf8"));
          const token = String(json(plain).token);
          assert.deepEqual(
            linesWithToken(plain, token),
            [],
            "a guarded handler's direct sign-up set the new user's session cookie on the caller",
          );
          for (const line of setCookieLines(plain.headers)) {
            if (line.startsWith(`${own.name}=`)) {
              assert.ok(
                decodeURIComponent(line).startsWith(
                  `${own.name}=${own.token}.`,
                ),
                "the caller's session cookie was replaced",
              );
            }
          }
          const forwarded = await boot.post(
            "sign-up-forwarded",
            await caller(),
          );
          assert.equal(forwarded.status, 201, forwarded.body.toString("utf8"));
          const forwardedToken = String(json(forwarded).token);
          assert.equal(
            linesWithToken(forwarded, forwardedToken).length,
            1,
            "@ForwardAuthCookies() did not forward the direct sign-up's session cookie",
          );
        }),
      skip,
    ),
    conformanceCase(
      "S-bridge-foreign-credentials",
      "foreign-credential cookies are forwarded only through forwardForeignCookies in a forwarding handler",
      () =>
        withBridge(async (boot, caller) => {
          const foreign = await kitIdentity(options.auth);
          const dropped = await boot.post("foreign-session", await caller(), {
            token: foreign.token,
          });
          assert.equal(dropped.status, 201, dropped.body.toString("utf8"));
          assert.deepEqual(
            linesWithToken(dropped, foreign.token),
            [],
            "a direct getSession with a foreign bearer token forwarded its refresh cookie",
          );
          const headers = await caller();
          const own = (await sessionToken(options.auth, headers))!;
          const signOut = await boot.post("sign-out", headers);
          assert.equal(signOut.status, 201, signOut.body.toString("utf8"));
          assert.ok(
            setCookieLines(signOut.headers).some(
              (line) =>
                line.startsWith(`${own.name}=`) &&
                (line.startsWith(`${own.name}=;`) || /max-age=0/i.test(line)),
            ),
            `the caller's own sign-out did not forward its cookie deletion: ${setCookieLines(signOut.headers).join(" | ")}`,
          );
          const explicit = await boot.post(
            "foreign-forwarded",
            await caller(),
            {
              token: foreign.token,
            },
          );
          assert.equal(explicit.status, 201, explicit.body.toString("utf8"));
          assert.equal(
            linesWithToken(explicit, foreign.token).length,
            1,
            "forwardForeignCookies() in a forwarding handler did not forward the foreign refresh cookie",
          );
          const undeclared = await boot.post(
            "foreign-undeclared",
            await caller(),
            { token: foreign.token },
          );
          assert.equal(
            json(undeclared).code,
            "FORWARDING_NOT_DECLARED",
            "forwardForeignCookies() ran outside a forwarding handler",
          );
          assert.deepEqual(linesWithToken(undeclared, foreign.token), []);
        }),
      skip,
    ),
  ];
}

/** A response header the probe sets on the source's own calls; it must never reach the client (S-cookie-forwarded). */
const CALL_HEADER = "x-conformance-call-header";

/** S-cookie-forwarded and S-infra-throws through a guarded route of the http harness. */
function httpRouteCases(
  options: PrincipalSourceConformanceOptions,
): ConformanceCase[] {
  const skip = options.http ? undefined : "the options give no http harness";
  const withRoute = async (
    fn: (
      boot: BridgeBoot,
      source: PrincipalSource,
      probe: ProbeState,
    ) => Promise<ConformanceOutcome>,
  ): Promise<ConformanceOutcome> => {
    const inspected = await harness(options);
    const { source, probe } = inspected;
    await inspected.close();
    const boot = await bootBridge(options, options.http!, source.kinds);
    try {
      return await fn(boot, source, probe);
    } finally {
      probe.storageFault = undefined;
      probe.responseHeader = undefined;
      await boot.close();
    }
  };
  return [
    conformanceCase(
      "S-infra-throws",
      "through an HTTP route: a storage outage answers 5xx, never 401 or 403",
      () =>
        withRoute(async (boot, _source, probe) => {
          const headers = await options.credentials.valid(options.auth);
          const calls = probe.calls.length;
          const storage = probe.storage.length;
          probe.storageFault = () => new Error("conformance storage outage");
          const response = await boot.post("principal", headers);
          probe.storageFault = undefined;
          if (
            probe.calls.length === calls &&
            probe.storage.length === storage
          ) {
            return conformanceSkip(
              "the source read no storage and called no Better Auth endpoint for a valid credential",
            );
          }
          assert.ok(
            response.status >= 500 && response.status < 600,
            `a guarded route answered ${response.status} for a storage outage instead of 5xx: ${response.body.toString("utf8")}`,
          );
        }),
      skip,
    ),
    conformanceCase(
      "S-cookie-forwarded",
      "through an HTTP route: each Set-Cookie line of the source's own-credential calls reaches the client exactly once, and no other header of those calls does",
      () =>
        withRoute(async (boot, source, probe) => {
          const headers = await options.credentials.valid(options.auth);
          const from = probe.produced.length;
          const calls = probe.calls.length;
          probe.responseHeader = () => [CALL_HEADER, "leaked"];
          const response = await boot.post("principal", headers);
          probe.responseHeader = undefined;
          assert.equal(
            response.status,
            201,
            `the guarded route answered ${response.status}: ${response.body.toString("utf8")}`,
          );
          const produced = ownCookies(
            probe,
            from,
            headers,
            source.credentialHeaders ?? [],
          );
          const delivered = setCookieLines(response.headers);
          for (const line of new Set(produced)) {
            assert.equal(
              occurrences(delivered, line),
              1,
              `the source's Better Auth calls produced ${names([line])[0]}, the client received it ${occurrences(delivered, line)} times (received: ${names(delivered).join(", ") || "nothing"})`,
            );
          }
          for (const line of delivered) {
            assert.ok(
              produced.includes(line),
              `the client received ${names([line])[0]}, which no call with the request's own credential produced`,
            );
          }
          if (probe.calls.length > calls) {
            assert.equal(
              response.headers[CALL_HEADER],
              undefined,
              "a header other than Set-Cookie that the source's Better Auth calls set reached the client",
            );
          }
        }),
      skip,
    ),
  ];
}

interface JwtApi {
  signJWT(input: {
    body: {
      payload: Record<string, unknown>;
      overrideOptions?: Record<string, unknown>;
    };
  }): Promise<{ token: string }>;
}

function jwtCases(
  options: PrincipalSourceConformanceOptions,
): ConformanceCase[] {
  const NOT_JWT = "the source does not require the jwt plugin";
  const jwtCase = (
    title: string,
    run: (
      harness: Harness,
      mint: JwtApi["signJWT"],
    ) => Promise<ConformanceOutcome>,
  ) =>
    conformanceCase("S-jwt-claims", title, () =>
      withHarness(options, async (harness) => {
        if (!(harness.source.requires?.plugins ?? []).includes("jwt")) {
          return conformanceSkip(NOT_JWT);
        }
        const api = harness.auth.api as unknown as JwtApi;
        return run(harness, (input) => api.signJWT(input));
      }),
    );
  const bearer = (token: string) =>
    new Headers({ authorization: `Bearer ${token}` });
  return [
    jwtCase(
      "a token signJWT minted verifies, and one minted under another issuer is rejected 401 INVALID_JWT",
      async ({ resolve }, mint) => {
        const subject = `conformance-${globalThis.crypto.randomUUID()}`;
        const { token } = await mint({ body: { payload: { sub: subject } } });
        const verified = await resolve(bearer(token), null);
        assert.equal(
          verified.outcome,
          "authenticated",
          `a token signJWT minted did not verify (iss/aud must be the baseURL origin): ${JSON.stringify(verified)}`,
        );
        const foreign = await mint({
          body: {
            payload: { sub: subject },
            overrideOptions: {
              jwt: { issuer: "https://conformance-foreign-issuer.example" },
            },
          },
        });
        const result = await settle(() => resolve(bearer(foreign.token), null));
        assert.equal(
          result.ok,
          true,
          `a foreign-issuer token threw: ${String(!result.ok && result.error)}`,
        );
        assertRejected(
          result.ok ? result.value : { outcome: "absent" },
          401,
          "INVALID_JWT",
          "a foreign-issuer token",
        );
      },
    ),
    jwtCase(
      "with the key-set read failing, a valid token answers 5xx",
      async ({ resolve, probe }, mint) => {
        const { token } = await mint({
          body: { payload: { sub: "conformance" } },
        });
        const from = probe.storage.length;
        probe.storageFault = (call) =>
          call.model === "jwks"
            ? new Error("conformance key-set outage")
            : undefined;
        const result = await settle(() => resolve(bearer(token), null));
        probe.storageFault = undefined;
        if (
          !probe.storage.slice(from).some((entry) => entry.endsWith(":jwks"))
        ) {
          return conformanceSkip(
            "the source served the key set from a cache; pass it as a factory reference so each case starts cold",
          );
        }
        assert.equal(
          result.ok,
          false,
          `a key-set outage resolved ${JSON.stringify(result.ok && result.value)}`,
        );
        assert.ok(
          !isAuthFailure(!result.ok && result.error),
          `a key-set outage was thrown as a denial: ${String(!result.ok && result.error)}`,
        );
      },
    ),
  ];
}
