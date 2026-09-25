import type { AuthContextView } from "./auth-contracts.js";

/** Auth route path exceptions never exempt application operations. */
export function originChecksDisabled(context: AuthContextView): boolean {
  return (
    context.skipCSRFCheck ||
    (context.skipOriginCheck === true &&
      context.options.advanced?.disableCSRFCheck === undefined)
  );
}

interface DynamicBaseURL {
  readonly allowedHosts: readonly string[];
  readonly protocol?: string;
  readonly fallback?: string;
}

function isDynamicBaseURL(value: unknown): value is DynamicBaseURL {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { allowedHosts?: unknown }).allowedHosts)
  );
}

/**
 * A subset of better-auth's loopback classification: every host accepted here is loopback there, so an unusual spelling
 * better-auth also accepts only makes the kernel stricter, never more lenient.
 */
function isLoopbackHost(host: string): boolean {
  let name = host.trim().toLowerCase();
  if (name.startsWith("[")) {
    return name.slice(1, name.indexOf("]")) === "::1";
  }
  const colon = name.indexOf(":");
  if (colon !== -1 && name.indexOf(":", colon + 1) === -1) {
    name = name.slice(0, colon);
  }
  name = name.replace(/\.+$/, "");
  if (name === "localhost" || name.endsWith(".localhost") || name === "::1") {
    return true;
  }
  const octets = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name);
  return !!octets && octets.slice(1).every((octet) => Number(octet) <= 255);
}

/** The origins better-auth's getTrustedOrigins() adds before the trustedOrigins option. */
function baseOrigins(context: AuthContextView): string[] {
  const configured = context.options.baseURL as unknown;
  if (isDynamicBaseURL(configured)) {
    const origins: string[] = [];
    const protocol = configured.protocol;
    for (const host of configured.allowedHosts) {
      if (host.includes("://")) {
        origins.push(host);
        continue;
      }
      if (!protocol || protocol === "https" || protocol === "auto") {
        origins.push(`https://${host}`);
      }
      if (protocol === "http" || protocol === "auto" || isLoopbackHost(host)) {
        origins.push(`http://${host}`);
      }
    }
    if (configured.fallback) {
      try {
        origins.push(new URL(configured.fallback).origin);
      } catch {
        // better-auth ignores an unparsable fallback here too.
      }
    }
    return origins;
  }
  try {
    return context.baseURL ? [new URL(context.baseURL).origin] : [];
  } catch {
    return [];
  }
}

function environmentOrigins(): string[] {
  const value = globalThis.process?.env?.BETTER_AUTH_TRUSTED_ORIGINS;
  return value ? value.split(",") : [];
}

export class TrustedOrigins {
  constructor(private readonly context: () => Promise<AuthContextView>) {}

  /**
   * The router's per-request list (better-auth getTrustedOrigins(options, request)). An array option is already part of
   * the init-time list; a function option is evaluated with the request only, because the init-time list also holds its
   * no-request result, which the router never trusts.
   */
  async list(request?: Request): Promise<readonly string[]> {
    const context = await this.context();
    const configured = context.options.trustedOrigins;
    const dynamic = typeof configured === "function";
    const contributed = dynamic ? await configured(request) : configured;
    const origins = new Set(
      dynamic ? baseOrigins(context) : context.trustedOrigins,
    );
    if (Array.isArray(contributed)) {
      for (const origin of contributed) {
        if (typeof origin === "string" && origin) {
          origins.add(origin);
        }
      }
    }
    if (dynamic) {
      for (const origin of environmentOrigins()) {
        if (origin) {
          origins.add(origin);
        }
      }
    }
    if (request && !context.options.baseURL && !context.baseURL) {
      origins.add(new URL(request.url).origin);
    }
    return [...origins];
  }

  async isTrusted(origin: string, request?: Request): Promise<boolean> {
    const [context, trustedOrigins] = await Promise.all([
      this.context(),
      this.list(request),
    ]);
    return context.isTrustedOrigin.call({ trustedOrigins }, origin, {
      allowRelativePaths: false,
    });
  }
}
