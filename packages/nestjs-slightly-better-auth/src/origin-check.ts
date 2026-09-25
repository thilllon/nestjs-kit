import type {
  AuthContextView,
  BrowserExposure,
  OriginCheckOptions,
} from "./auth-contracts.js";
import {
  AuthFailures,
  type AuthFailure,
  BetterAuthConfigurationError,
  createInfrastructureError,
  isConfigurationError,
  isInfrastructureError,
} from "./auth-errors.js";
import { memoKey, RequestScope } from "./request-scope.js";
import { originChecksDisabled, TrustedOrigins } from "./trusted-origins.js";

const ORIGIN_PROOF = Symbol.for("nestjs-slightly-better-auth:origin-proof");
const ORIGIN_CALCULATION_FAILURES = Symbol.for(
  "nestjs-slightly-better-auth:origin-calculation-failures",
);

function diagnosticOrigin(headers: Headers): string {
  const origin = headers.get("origin");
  const referer = headers.get("referer");
  let value = origin || referer || "(missing)";
  if (!origin && referer) {
    try {
      value = new URL(referer).origin;
    } catch {
      value = "(invalid referer)";
    }
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Remove attacker-controlled log control characters.
  return value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 100);
}

/** Bounded, per-application diagnostics; the next denial rolls the window without timers. */
export class OriginDiagnostics {
  #openedAt: number | undefined;
  readonly #pairs = new Set<string>();
  readonly #further = new Map<string, number>();
  readonly #origins = new Map<string, number>();

  constructor(
    private readonly logger: {
      warn(message: string): void;
      debug(message: string): void;
    },
  ) {}

  record(
    instance: string,
    failure: AuthFailure,
    headers: Headers,
    trustedCount: number,
  ): void {
    const now = Date.now();
    if (this.#openedAt !== undefined && now - this.#openedAt >= 3_600_000) {
      this.logger.warn(
        `Origin check window closed: further denials ${JSON.stringify([...this.#further])}; frequent origins ${JSON.stringify([...this.#origins].sort((a, b) => b[1] - a[1]).slice(0, 5))}`,
      );
      this.#pairs.clear();
      this.#further.clear();
      this.#origins.clear();
      this.#openedAt = undefined;
    }
    this.#openedAt ??= now;
    const origin = diagnosticOrigin(headers);
    const reason = failure.reason ?? failure.code;
    const pair = JSON.stringify([reason, origin]);
    const message = `Origin check ${instance}: ${reason}, origin ${origin}, trusted origins ${trustedCount}. Add the origin to trustedOrigins or send Origin from non-browser clients.`;
    if (!this.#pairs.has(pair) && this.#pairs.size < 100) {
      this.#pairs.add(pair);
      this.logger.warn(message);
    } else {
      this.#further.set(reason, (this.#further.get(reason) ?? 0) + 1);
    }
    if (this.#origins.has(origin) || this.#origins.size < 100) {
      this.#origins.set(origin, (this.#origins.get(origin) ?? 0) + 1);
    }
    this.logger.debug(message);
  }

  advisoryFailure(
    instance: string,
    headers: Headers,
    trustedCount: number,
  ): void {
    this.record(
      instance,
      AuthFailures.forbidden("ORIGIN_CHECK_UNAVAILABLE"),
      headers,
      trustedCount,
    );
  }
}

export interface OriginCheckInit {
  readonly instance: string;
  readonly context: AuthContextView;
  readonly options?: OriginCheckOptions;
  readonly diagnostics?: OriginDiagnostics;
  readonly credentialHeaders?: readonly string[];
  readonly exposeRawCause?: boolean;
}

export class OriginCheck {
  readonly #trusted: TrustedOrigins;
  readonly #trustedCounts = new WeakMap<object, number>();

  constructor(
    private readonly scope: RequestScope,
    private readonly init: OriginCheckInit,
  ) {
    this.#trusted = new TrustedOrigins(async () => init.context);
  }

  check(
    browser: BrowserExposure,
    mode: "cookie" | "form",
  ): Promise<AuthFailure | null> {
    const origins = this.scope.stateFor(browser.key).origins;
    // Operations of one batched GraphQL request share a leg key but not enforcement, and only the advisory verdict
    // infers a same-origin leg without Origin and Referer.
    const key = memoKey(
      this.init.instance,
      mode === "cookie" && !browser.enforce ? "cookie-advisory" : mode,
    );
    const existing = origins.get(key);
    if (existing) {
      return existing;
    }
    let headers: Headers | undefined;
    let calculationFailed = false;
    const promise = Promise.resolve()
      .then(async () => {
        if (
          this.init.options?.mode === "off" ||
          originChecksDisabled(this.init.context)
        ) {
          return null;
        }
        headers = browser.headers();
        const failure = await this.verdict(browser, headers, mode, () => {
          calculationFailed = true;
        });
        if (failure) {
          this.init.diagnostics?.record(
            this.init.instance,
            failure,
            headers,
            this.#trustedCounts.get(browser.key) ??
              this.init.context.trustedOrigins.length,
          );
        } else {
          // Cookie-free cookie mode does not establish evidence about an origin.
          if (mode === "form" || headers.has("cookie")) {
            this.scope
              .stateFor(browser.key)
              .values.set(
                this.scope.valueKey(this.init.instance, ORIGIN_PROOF),
                true,
              );
          }
        }
        return failure;
      })
      .catch((error: unknown) => {
        if (origins.get(key) === promise) {
          origins.delete(key);
        }
        if (isConfigurationError(error)) {
          throw error;
        }
        const failure = isInfrastructureError(error)
          ? error
          : createInfrastructureError(error, {
              headers,
              credentialHeaders: this.init.credentialHeaders,
              exposeRawCause: this.init.exposeRawCause,
            });
        if (calculationFailed && headers) {
          this.calculationFailures(browser).set(promise, headers);
        }
        throw failure;
      });
    origins.set(key, promise);
    return promise;
  }

  async advisory(browser: BrowserExposure): Promise<void> {
    const verdict = this.check(browser, "cookie");
    try {
      await verdict;
    } catch (error) {
      const headers = this.calculationFailures(browser).get(verdict);
      if (!isInfrastructureError(error) || !headers) {
        throw error;
      }
      // Only failed origin calculations are advisory. Logging reuses the successful extraction.
      this.init.diagnostics?.advisoryFailure(
        this.init.instance,
        headers,
        this.init.context.trustedOrigins.length,
      );
    }
  }

  assertCallerSession(
    browser: BrowserExposure,
    path: string,
    instance: string,
  ): void {
    if (
      instance === this.init.instance &&
      (this.init.options?.mode === "off" ||
        originChecksDisabled(this.init.context) ||
        this.scope
          .stateFor(browser.key)
          .values.get(this.scope.valueKey(this.init.instance, ORIGIN_PROOF)) ===
          true)
    ) {
      return;
    }
    throw BetterAuthConfigurationError.atRequest(
      "PUBLIC_HANDLER_USED_CALLER_SESSION",
      "A direct caller-session call requires a passing origin verdict for this browser leg and instance",
      {
        site: path,
        hint: "Guard the handler and pass its origin check before making this call.",
      },
    );
  }

  private calculationFailures(
    browser: BrowserExposure,
  ): WeakMap<Promise<AuthFailure | null>, Headers> {
    const values = this.scope.stateFor(browser.key).values;
    const key = this.scope.valueKey(
      this.init.instance,
      ORIGIN_CALCULATION_FAILURES,
    );
    let failures = values.get(key) as
      | WeakMap<Promise<AuthFailure | null>, Headers>
      | undefined;
    if (!failures) {
      failures = new WeakMap();
      values.set(key, failures);
    }
    return failures;
  }

  private async verdict(
    browser: BrowserExposure,
    headers: Headers,
    mode: "cookie" | "form",
    onCalculationFailure: () => void,
  ): Promise<AuthFailure | null> {
    if (!headers.has("cookie")) {
      if (mode === "cookie") {
        return null;
      }
      const site = headers.get("sec-fetch-site");
      const navigation = headers.get("sec-fetch-mode");
      const metadata = [site, navigation, headers.get("sec-fetch-dest")].some(
        (value) => Boolean(value?.trim()),
      );
      if (metadata && site === "cross-site" && navigation === "navigate") {
        return AuthFailures.forbidden("CROSS_SITE_NAVIGATION_LOGIN_BLOCKED");
      }
      if (!metadata && !headers.get("origin") && !headers.get("referer")) {
        return null;
      }
    }
    const origin = headers.get("origin");
    const referer = headers.get("referer");
    const site = headers.get("sec-fetch-site");
    // A browser sends no Origin on a same-origin GET, and a no-referrer policy removes Referer. On a non-enforcing
    // (advisory) cookie leg, the browser-controlled Sec-Fetch-Site: same-origin then stands for the leg's own origin,
    // as Origin: null does on every leg. Enforcing legs keep better-auth's rule.
    const inferred =
      site === "same-origin" &&
      (origin === "null" ||
        (mode === "cookie" && !browser.enforce && !origin && !referer));
    const value = inferred ? new URL(browser.url).origin : origin || referer;
    if (!value || value === "null") {
      if (
        this.init.options?.missingOrigin === "allow-non-browser" &&
        !headers.has("origin") &&
        !headers.has("referer") &&
        !headers.has("sec-fetch-site")
      ) {
        return null;
      }
      return AuthFailures.forbidden("MISSING_OR_NULL_ORIGIN");
    }
    const request = new Request(browser.url, { headers });
    const trustedOrigins = await this.#trusted
      .list(request)
      .catch((error: unknown) => {
        onCalculationFailure();
        throw error;
      });
    this.#trustedCounts.set(browser.key, trustedOrigins.length);
    return this.init.context.isTrustedOrigin.call({ trustedOrigins }, value, {
      allowRelativePaths: false,
    })
      ? null
      : AuthFailures.forbidden("INVALID_ORIGIN");
  }
}
