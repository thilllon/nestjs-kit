import assert from "node:assert/strict";
import { Test, type TestingModule } from "@nestjs/testing";
import type {
  AuthHandle,
  CookieSink,
  ExtensionRef,
  PrincipalRequest,
  PrincipalResult,
  PrincipalSource,
} from "./auth-contracts.js";
import { isAuthFailure } from "./auth-errors.js";
import { BetterAuthModule } from "./auth-module.js";
import { getBetterAuthHandleToken, getExtensionToken } from "./auth-tokens.js";
import type { AuthLike } from "./auth-types.js";
import {
  type ConformanceCase,
  conformanceCase,
  probeOf,
  type ProbeState,
  settle,
} from "./conformance-fixtures.js";

export interface PrincipalSourceConformanceOptions {
  source: ExtensionRef<PrincipalSource>;
  /**
   * The Better Auth instance the credentials belong to. It must include conformanceProbePlugin(), testUtils() and
   * nestjs(), with session.updateAge 0 and advanced.disableOriginCheck false: createConformanceAuth({ plugins }) builds one.
   */
  auth: AuthLike;
  credentials: {
    valid(): Promise<Headers>;
    invalid(): Headers;
    rateLimited?(): Promise<Headers>;
  };
}

interface Harness {
  readonly source: PrincipalSource;
  readonly handle: AuthHandle;
  readonly probe: ProbeState;
  resolve(
    headers: Headers,
    cookies: CookieSink | null,
  ): Promise<PrincipalResult>;
  close(): Promise<void>;
}

class RecordingSink implements CookieSink {
  readonly values: string[] = [];

  append(setCookies: readonly string[]): boolean {
    this.values.push(...setCookies);
    return true;
  }
}

async function harness(
  options: PrincipalSourceConformanceOptions,
): Promise<Harness> {
  const probe = await probeOf(options.auth);
  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [
      BetterAuthModule.forRoot({
        auth: options.auth,
        principals: [options.source],
        session: false,
        http: { mount: false },
        logSummary: false,
      } as never),
    ],
  }).compile();
  moduleRef.useLogger(false);
  await moduleRef.init();
  const handle = moduleRef.get<AuthHandle>(getBetterAuthHandleToken());
  const source = moduleRef.get<PrincipalSource>(
    getExtensionToken("principals", "default", 0),
  );
  return {
    source,
    handle,
    probe,
    resolve(headers, cookies) {
      const memo = new Map<unknown, Promise<unknown>>();
      const request: PrincipalRequest = {
        headers,
        cookies,
        transport: "conformance",
        freshness: "default",
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
    close: () => moduleRef.close(),
  };
}

async function withHarness(
  options: PrincipalSourceConformanceOptions,
  fn: (harness: Harness) => Promise<void>,
): Promise<void> {
  const value = await harness(options);
  try {
    await fn(value);
  } finally {
    value.probe.fault = undefined;
    await value.close();
  }
}

function names(cookies: readonly string[]): string[] {
  return cookies.map((line) => line.split("=", 1)[0]!);
}

/**
 * The principal-source kit (invariants P1–P7). It resolves the source directly inside the resolver's chain scope,
 * so a source that throws for invalid credentials fails S-rejected-not-thrown although core would normalize the
 * throw at runtime. Storage faults are injected through the probe plugin's before hook.
 */
export function principalSourceConformance(
  options: PrincipalSourceConformanceOptions,
): ConformanceCase[] {
  const add = (
    id: string,
    title: string,
    run: (harness: Harness) => Promise<void>,
    skip?: string,
  ) => conformanceCase(id, title, () => withHarness(options, run), skip);
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
      "a storage failure makes resolve throw instead of denying",
      async ({ resolve, probe }) => {
        const headers = await options.credentials.valid();
        const calls = probe.calls.length;
        probe.fault = () => new Error("conformance storage outage");
        const result = await settle(() =>
          resolve(headers, new RecordingSink()),
        );
        if (probe.calls.length === calls) {
          return;
        }
        assert.equal(
          result.ok,
          false,
          `a storage failure resolved ${JSON.stringify(result.ok && result.value)}`,
        );
      },
    ),
    add(
      "S-cookie-forwarded",
      "cookies of the source's own-credential calls reach the sink exactly once",
      async ({ resolve }) => {
        const sink = new RecordingSink();
        const result = await resolve(await options.credentials.valid(), sink);
        assert.equal(result.outcome, "authenticated");
        const seen = names(sink.values);
        assert.deepEqual(
          seen,
          [...new Set(seen)],
          `a cookie was delivered twice: ${sink.values.join(" | ")}`,
        );
      },
    ),
    add(
      "S-refresh-suppressed",
      "resolving without a cookie sink refreshes nothing",
      async ({ resolve, probe }) => {
        const headers = await options.credentials.valid();
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
      async ({ resolve, source }) => {
        const result = await resolve(
          await options.credentials.valid(),
          new RecordingSink(),
        );
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
      async ({ resolve, source }) => {
        const headers = await options.credentials.valid();
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
      async ({ resolve, source, handle }) => {
        const getSession = (headers: Headers) =>
          (
            handle.api as {
              getSession(input: { headers: Headers }): Promise<unknown>;
            }
          ).getSession({ headers });
        for (const headers of [
          await options.credentials.valid(),
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
      async ({ resolve, source }) => {
        const result = await resolve(
          await options.credentials.valid(),
          new RecordingSink(),
        );
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
      async ({ resolve }) => {
        const result = await resolve(
          await options.credentials.rateLimited!(),
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
  ];
}
