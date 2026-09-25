import {
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
  request as nodeRequest,
} from "node:http";
import { inspect } from "node:util";
import type { LoggerService } from "@nestjs/common";
import {
  betterAuth,
  type BetterAuthOptions,
  type BetterAuthPlugin,
} from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  getIP,
  getShouldSkipSessionRefresh,
} from "better-auth/api";
import { bearer, testUtils } from "better-auth/plugins";
import type {
  ConformanceCase,
  ConformanceOutcome,
  ConformanceRunner,
  ConformanceSkip,
} from "./auth-contracts.js";
import { BetterAuthConfigurationError } from "./auth-errors.js";
import type { AuthLike } from "./auth-types.js";
import { nestjs } from "./plugin.js";

export type {
  ConformanceCase,
  ConformanceOutcome,
  ConformanceRunner,
  ConformanceSkip,
} from "./auth-contracts.js";

export const PROBE_PLUGIN_ID = "nestjs-slightly-better-auth-conformance-probe";
/** The trusted origin the probe plugin contributes through init(), so origin cases see the post-init set. */
export const PROBE_TRUSTED_ORIGIN = "https://probe-plugin.example";
export const KIT_BASE_URL = "http://localhost:3000";
export const UNTRUSTED_ORIGIN = "https://evil.example";
const PROBE_STATE = Symbol.for("nestjs-slightly-better-auth:conformance-probe");

/** One database adapter operation the probe observed. */
export interface StorageCall {
  readonly method: string;
  readonly model: string | undefined;
}

/** The Set-Cookie lines one dispatched endpoint produced, with the request headers of that call. */
export interface ProducedCookies {
  readonly path: string;
  readonly setCookies: readonly string[];
  readonly headers: Headers | undefined;
  /** The instance's session cookie name, to compare the call's credential with a request's. */
  readonly sessionCookie: string;
}

/** Observations and fault injection of one conformanceProbePlugin() object. */
export interface ProbeState {
  /** Every endpoint path Better Auth dispatched (router and auth.api), in order. */
  readonly calls: string[];
  /** Database writes as `<model>.<create|update|delete>`. */
  readonly writes: string[];
  /** Every database adapter operation as `<method>:<model>`, reads included, transactions included. */
  readonly storage: string[];
  /** Endpoint dispatches that produced Set-Cookie lines, seen by an after hook. */
  readonly produced: ProducedCookies[];
  /** getShouldSkipSessionRefresh() observed by an after hook, per dispatched path. */
  readonly refresh: { readonly path: string; readonly skip: boolean }[];
  /** 'middleware' and 'auth' markers for ordering cases. */
  readonly order: string[];
  /** Returns a value to throw from the before hook for a path; undefined dispatches normally. */
  fault: ((path: string) => unknown) | undefined;
  /** Returns a value to throw from a database adapter operation (a storage outage); undefined runs it. */
  storageFault: ((call: StorageCall) => unknown) | undefined;
  /** Milliseconds the before hook waits for a path, so that concurrent sources settle in a chosen order. */
  delay: ((path: string) => number | undefined) | undefined;
  streamCancelled: boolean;
}

export function createProbeState(): ProbeState {
  return {
    calls: [],
    writes: [],
    storage: [],
    produced: [],
    refresh: [],
    order: [],
    fault: undefined,
    storageFault: undefined,
    delay: undefined,
    streamCancelled: false,
  };
}

/** A case result: the case does not apply to this unit, for the given reason. */
export function conformanceSkip(reason: string): ConformanceSkip {
  return { skipped: reason };
}

const STORAGE_METHODS = [
  "create",
  "update",
  "updateMany",
  "findOne",
  "findMany",
  "delete",
  "deleteMany",
  "consumeOne",
  "count",
] as const;
const INSTRUMENTED = Symbol("nestjs-slightly-better-auth:conformance-storage");

/** Counts and faults every data operation of a database adapter in place, including the adapters of its transactions. */
function instrumentStorage(adapter: unknown, state: ProbeState): void {
  if (
    !adapter ||
    typeof adapter !== "object" ||
    Reflect.get(adapter, INSTRUMENTED)
  ) {
    return;
  }
  const target = adapter as Record<string, unknown>;
  Object.defineProperty(target, INSTRUMENTED, { value: true });
  for (const method of STORAGE_METHODS) {
    const original = target[method];
    if (typeof original !== "function") {
      continue;
    }
    target[method] = async (...args: unknown[]) => {
      const model = (args[0] as { model?: unknown } | undefined)?.model;
      const call = {
        method,
        model: typeof model === "string" ? model : undefined,
      };
      state.storage.push(`${method}:${call.model ?? ""}`);
      const fault = state.storageFault?.(call);
      if (fault !== undefined) {
        throw fault;
      }
      return (original as (...values: unknown[]) => unknown).apply(
        target,
        args,
      );
    };
  }
  const transaction = target.transaction;
  if (typeof transaction === "function") {
    target.transaction = (callback: (adapter: unknown) => unknown) =>
      (transaction as (fn: (adapter: unknown) => unknown) => unknown).call(
        target,
        (inner: unknown) => {
          instrumentStorage(inner, state);
          return callback(inner);
        },
      );
  }
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function writes(state: ProbeState) {
  const record = (entry: string) => async () => {
    state.writes.push(entry);
  };
  return Object.fromEntries(
    ["user", "session", "account", "verification"].map((model) => [
      model,
      {
        create: { after: record(`${model}.create`) },
        update: { after: record(`${model}.update`) },
        delete: { after: record(`${model}.delete`) },
      },
    ]),
  );
}

/**
 * The conformance kits' Better Auth probe: byte-exact echo, multi-cookie, redirect, stream, HTML, method, URL
 * and IP endpoints under /probe, a before hook that counts dispatches and injects faults, an after hook that
 * records refresh suppression and the Set-Cookie lines each call produced, database write counters, a storage
 * instrument that counts and faults every database adapter operation, and https://probe-plugin.example as a trusted
 * origin contributed through init(). Put it before nestjs() in the plugin list.
 */
export function conformanceProbePlugin(): BetterAuthPlugin {
  return probePlugin();
}

function probePlugin(
  options: { memoryTables?: Record<string, unknown[]> } = {},
): BetterAuthPlugin {
  const state = createProbeState();
  const plugin = {
    id: PROBE_PLUGIN_ID,
    init(context: { adapter: unknown; tables?: object }) {
      if (options.memoryTables) {
        for (const table of Object.values(context.tables ?? {}) as {
          modelName: string;
        }[]) {
          options.memoryTables[table.modelName] ??= [];
        }
      }
      instrumentStorage(context.adapter, state);
      return {
        options: {
          trustedOrigins: [PROBE_TRUSTED_ORIGIN],
          databaseHooks: writes(state),
        },
      };
    },
    endpoints: {
      probeEchoRaw: createAuthEndpoint(
        "/probe/echo-raw",
        {
          method: ["GET", "POST", "PUT", "PATCH", "DELETE"],
          disableBody: true,
          requireRequest: true,
        },
        async (ctx) => {
          state.order.push("auth");
          const bytes = new Uint8Array(await ctx.request.arrayBuffer());
          return Response.json({
            method: ctx.request.method,
            url: ctx.request.url,
            headers: [...ctx.request.headers],
            body: base64(bytes),
          });
        },
      ),
      probeMultiCookie: createAuthEndpoint(
        "/probe/multi-cookie",
        { method: "GET" },
        async (ctx) => {
          ctx.setCookie("probe_a", "alpha", { path: "/" });
          ctx.setCookie("probe_b", "beta", { path: "/" });
          ctx.setCookie("probe_c", "gamma, delta", { path: "/" });
          return ctx.json({ cookies: 3 });
        },
      ),
      probeRedirect: createAuthEndpoint(
        "/probe/redirect",
        { method: "GET" },
        async () =>
          new Response(null, {
            status: 302,
            headers: [
              ["location", `${PROBE_TRUSTED_ORIGIN}/next`],
              ["set-cookie", "probe_redirect=1; Path=/"],
            ],
          }),
      ),
      probeStream: createAuthEndpoint(
        "/probe/stream",
        { method: "GET" },
        async () => {
          let index = 0;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
              return new Promise<void>((resolve) => {
                timer = setTimeout(() => {
                  if (index === 3) {
                    controller.close();
                  } else {
                    controller.enqueue(
                      new TextEncoder().encode(`chunk-${index++};`),
                    );
                  }
                  resolve();
                }, 25);
              });
            },
            cancel() {
              clearTimeout(timer);
              state.streamCancelled = true;
            },
          });
          return new Response(stream, {
            headers: { "content-type": "text/plain" },
          });
        },
      ),
      probeHtml: createAuthEndpoint(
        "/probe/html",
        { method: "GET" },
        async () =>
          new Response("<p>probe</p>", {
            headers: {
              "content-type": "text/html; charset=utf-8",
              vary: "Accept",
            },
          }),
      ),
      probePut: createAuthEndpoint(
        "/probe/put",
        { method: "PUT" },
        async (ctx) => ctx.json({ method: "PUT" }),
      ),
      probePatch: createAuthEndpoint(
        "/probe/patch",
        { method: "PATCH" },
        async (ctx) => ctx.json({ method: "PATCH" }),
      ),
      probeDelete: createAuthEndpoint(
        "/probe/delete",
        { method: "DELETE" },
        async (ctx) => ctx.json({ method: "DELETE" }),
      ),
      probeUrl: createAuthEndpoint(
        "/probe/url",
        { method: "GET", requireRequest: true },
        async (ctx) => ctx.json({ url: ctx.request.url }),
      ),
      probeIp: createAuthEndpoint(
        "/probe/ip",
        { method: "GET", requireRequest: true },
        async (ctx) =>
          ctx.json({
            ip: getIP(ctx.request, ctx.context.options),
            resolved: resolvedIp(ctx.request, ctx.context.options),
          }),
      ),
      probeThrowApiError: createAuthEndpoint(
        "/probe/throw-api-error",
        { method: "GET" },
        async () => {
          throw new APIError("BAD_REQUEST", {
            code: "PROBE_API_ERROR",
            message: "Probe API error",
          });
        },
      ),
      probeThrowError: createAuthEndpoint(
        "/probe/throw-error",
        { method: "GET" },
        async () => {
          throw new Error("probe infrastructure failure");
        },
      ),
    },
    hooks: {
      before: [
        {
          matcher: () => true,
          handler: createAuthMiddleware(async (ctx) => {
            state.calls.push(ctx.path);
            const wait = state.delay?.(ctx.path);
            if (wait) {
              await new Promise((resolve) => setTimeout(resolve, wait));
            }
            const fault = state.fault?.(ctx.path);
            if (fault !== undefined) {
              throw fault;
            }
          }),
        },
      ],
      after: [
        {
          matcher: () => true,
          handler: createAuthMiddleware(async (ctx) => {
            state.refresh.push({
              path: ctx.path,
              skip: (await getShouldSkipSessionRefresh()) === true,
            });
            const setCookies =
              ctx.context.responseHeaders?.getSetCookie() ?? [];
            if (setCookies.length) {
              state.produced.push({
                path: ctx.path,
                setCookies,
                headers: ctx.headers ? new Headers(ctx.headers) : undefined,
                sessionCookie: ctx.context.authCookies.sessionToken.name,
              });
            }
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
  Object.defineProperty(plugin, PROBE_STATE, { value: state });
  return plugin;
}

/** A TEST-NET-2 address that no kit request sends and no kit configuration trusts. */
const IP_SENTINEL = "198.51.100.254";
const IP_SENTINEL_HEADER = "x-conformance-ip-sentinel";

/**
 * The client IP Better Auth resolves from the request's IP headers, without the localhost fallback getIP() returns
 * under NODE_ENV=development/test or a truthy TEST (vitest sets it): the sentinel header is read last, so getIP()
 * returns the sentinel exactly when the configured headers yield no trusted address.
 */
function resolvedIp(request: Request, options: BetterAuthOptions) {
  const ipAddress = options.advanced?.ipAddress;
  const headers = new Headers(request.headers);
  headers.set(IP_SENTINEL_HEADER, IP_SENTINEL);
  const ip = getIP(headers, {
    ...options,
    advanced: {
      ...options.advanced,
      ipAddress: {
        ...ipAddress,
        ipAddressHeaders: [
          ...(ipAddress?.ipAddressHeaders ?? ["x-forwarded-for"]),
          IP_SENTINEL_HEADER,
        ],
      },
    },
  });
  return ip === IP_SENTINEL ? null : ip;
}

/** The probe state of an instance that includes conformanceProbePlugin(). */
export async function probeOf(auth: AuthLike): Promise<ProbeState> {
  const context = (await auth.$context) as { getPlugin(id: string): unknown };
  const plugin = context.getPlugin(PROBE_PLUGIN_ID);
  const state =
    plugin && typeof plugin === "object"
      ? (Reflect.get(plugin, PROBE_STATE) as ProbeState | undefined)
      : undefined;
  if (!state) {
    throw new BetterAuthConfigurationError(
      "CONFORMANCE_PROBE_MISSING",
      "The conformance kits need conformanceProbePlugin() on the Better Auth instance.",
      "Create the instance with createConformanceAuth() or add conformanceProbePlugin() before nestjs().",
    );
  }
  return state;
}

/**
 * A memory-adapter Better Auth instance with the settings the kits assume: origin checks explicitly on
 * (advanced.disableOriginCheck: false, which vitest's TEST=true would otherwise switch off, and
 * advanced.disableCSRFCheck: false, which would otherwise switch every origin check off), session.updateAge 0 so
 * every session read refreshes, testUtils(), bearer(), conformanceProbePlugin() and nestjs() last. The kit settings
 * win over the same options in `options`.
 */
export function createConformanceAuth(
  options: Omit<BetterAuthOptions, "database"> = {},
): AuthLike {
  // The probe creates a table for every model of the resolved schema when Better Auth initializes it.
  const tables: Record<string, unknown[]> = {};
  const resolved = {
    secret: globalThis.crypto.randomUUID() + globalThis.crypto.randomUUID(),
    baseURL: KIT_BASE_URL,
    emailAndPassword: { enabled: true },
    logger: { disabled: true },
    ...options,
    session: { ...options.session, updateAge: 0 },
    advanced: {
      ...options.advanced,
      disableOriginCheck: false,
      disableCSRFCheck: false,
    },
    plugins: [
      testUtils(),
      bearer(),
      probePlugin({ memoryTables: tables }),
      ...(options.plugins ?? []),
      nestjs(),
    ],
  } satisfies BetterAuthOptions;
  return betterAuth<BetterAuthOptions>({
    ...resolved,
    database: memoryAdapter(tables),
  }) as unknown as AuthLike;
}

interface TestHelpers {
  createUser(overrides?: Record<string, unknown>): { id: string };
  saveUser(user: { id: string }): Promise<{ id: string }>;
  login(options: { userId: string }): Promise<{
    headers: Headers;
    token: string;
    session: { token: string; expiresAt: Date };
  }>;
}

export interface KitIdentity {
  readonly userId: string;
  readonly email: string;
  readonly password?: string;
  /** Cookie header value of a fresh session. */
  readonly cookie: string;
  /** Raw session token for the bearer() plugin. */
  readonly token: string;
}

export async function testHelpers(auth: AuthLike): Promise<TestHelpers> {
  const context = (await auth.$context) as { test?: TestHelpers };
  if (!context.test) {
    throw new BetterAuthConfigurationError(
      "TEST_UTILS_MISSING",
      "The conformance kits need Better Auth's testUtils() plugin on the instance.",
      "Create the instance with createConformanceAuth() or add testUtils().",
    );
  }
  return context.test;
}

/** A stored user with a fresh session; `password` signs the user up through Better Auth instead. */
export async function kitIdentity(
  auth: AuthLike,
  options: { password?: boolean; role?: string } = {},
): Promise<KitIdentity> {
  const helpers = await testHelpers(auth);
  const email = `${globalThis.crypto.randomUUID()}@conformance.example`;
  let userId: string;
  let password: string | undefined;
  if (options.password) {
    password = `pw-${globalThis.crypto.randomUUID()}`;
    const result = (await (
      auth.api as unknown as {
        signUpEmail(input: {
          body: { email: string; password: string; name: string };
        }): Promise<{ user: { id: string } }>;
      }
    ).signUpEmail({ body: { email, password, name: "Conformance" } })) as {
      user: { id: string };
    };
    userId = result.user.id;
  } else {
    userId = (
      await helpers.saveUser(
        helpers.createUser({
          email,
          name: "Conformance",
          ...(options.role ? { role: options.role } : {}),
        }),
      )
    ).id;
  }
  const login = await helpers.login({ userId });
  return {
    userId,
    email,
    password,
    cookie: login.headers.get("cookie") ?? "",
    token: login.token,
  };
}

/** Build the cases that one kit returns. */
export function conformanceCase(
  id: string,
  title: string,
  run: () => Promise<ConformanceOutcome>,
  skip?: string,
): ConformanceCase {
  return skip === undefined ? { id, title, run } : { id, title, skip, run };
}

/**
 * Register cases with a runner that has describe/it (vitest, jest, node:test). Cases are grouped by id. A case with
 * `skip` registers a passing test whose name states the reason, so every unsupported capability stays visible. A case
 * that skips at run time calls the runner's context.skip(reason) when the runner passes a context (Vitest, node:test);
 * under Jest it passes.
 */
export function runConformance(
  cases: readonly ConformanceCase[],
  runner: ConformanceRunner,
): void {
  const groups = new Map<string, ConformanceCase[]>();
  for (const item of cases) {
    groups.set(item.id, [...(groups.get(item.id) ?? []), item]);
  }
  for (const [id, items] of groups) {
    runner.describe(id, () => {
      for (const item of items) {
        if (item.skip !== undefined) {
          runner.it(`${item.title} (skipped: ${item.skip})`, async () => {});
        } else {
          // No declared parameters: Jest would treat one as a done callback, and Vitest parses it for fixtures.
          runner.it(item.title, async function () {
            // biome-ignore lint/complexity/noArguments: see above; the runner's test context is the first argument.
            const context = arguments[0] as
              | { skip?: (note?: string) => void }
              | undefined;
            const result = await item.run();
            if (result && typeof result.skipped === "string") {
              context?.skip?.(result.skipped);
            }
          });
        }
      }
    });
  }
}

export interface LogEntry {
  readonly level: "log" | "error" | "warn" | "debug" | "verbose" | "fatal";
  readonly text: string;
}

function render(value: unknown): string {
  if (value instanceof Error) {
    return inspect(value, { depth: 4 });
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** A Nest logger that records every entry for log assertions. */
export class CapturingLogger implements LoggerService {
  readonly entries: LogEntry[] = [];

  private record(level: LogEntry["level"], values: unknown[]): void {
    this.entries.push({ level, text: values.map(render).join(" ") });
  }

  log(...values: unknown[]): void {
    this.record("log", values);
  }

  error(...values: unknown[]): void {
    this.record("error", values);
  }

  warn(...values: unknown[]): void {
    this.record("warn", values);
  }

  debug(...values: unknown[]): void {
    this.record("debug", values);
  }

  verbose(...values: unknown[]): void {
    this.record("verbose", values);
  }

  fatal(...values: unknown[]): void {
    this.record("fatal", values);
  }

  errors(): LogEntry[] {
    return this.entries.filter(
      (entry) => entry.level === "error" || entry.level === "fatal",
    );
  }

  text(): string {
    return this.entries.map((entry) => entry.text).join("\n");
  }
}

export interface RawResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

/**
 * An HTTP/1.1 request through node:http, which adds no fetch metadata (Sec-Fetch-*) and keeps every Set-Cookie line.
 * `chunks` sends a chunked body; `abortAfterFirstChunk` destroys the response after its first data event.
 */
export function sendRaw(
  url: string,
  options: {
    method?: string;
    headers?: OutgoingHttpHeaders;
    body?: Uint8Array | string;
    chunks?: readonly (Uint8Array | string)[];
    timeoutMs?: number;
    abortAfterFirstChunk?: boolean;
  } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = nodeRequest(
      url,
      {
        method: options.method ?? "GET",
        headers: options.headers,
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
          if (options.abortAfterFirstChunk) {
            response.destroy();
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: Buffer.concat(chunks),
            });
          }
        });
        response.once("error", reject);
        response.once("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    request.setTimeout(options.timeoutMs ?? 5_000, () => {
      request.destroy(new Error(`Request to ${url} timed out`));
    });
    request.once("error", reject);
    if (options.chunks) {
      for (const chunk of options.chunks) {
        request.write(chunk);
      }
    } else if (options.body !== undefined) {
      request.write(options.body);
    }
    request.end();
  });
}

export function setCookieLines(headers: IncomingHttpHeaders): string[] {
  const value = headers["set-cookie"];
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

export async function settle<T>(
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error };
  }
}

/** Collect issue codes from an AUTH_BOOT_FAILED error (or the codes of a single configuration error). */
export function bootIssueCodes(error: unknown): string[] {
  const codes: string[] = [];
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") {
      return;
    }
    const code = Reflect.get(value, "code");
    if (typeof code === "string") {
      codes.push(code);
    }
    const issues = Reflect.get(value, "issues");
    if (Array.isArray(issues)) {
      issues.forEach(visit);
    }
  };
  visit(error);
  return codes;
}
