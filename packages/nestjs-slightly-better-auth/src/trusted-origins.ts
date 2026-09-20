import type { AuthContextView } from "./auth-contracts.js";

/** Auth route path exceptions never exempt application operations. */
export function originChecksDisabled(context: AuthContextView): boolean {
  return (
    context.skipCSRFCheck ||
    (context.skipOriginCheck === true &&
      context.options.advanced?.disableCSRFCheck === undefined)
  );
}

export class TrustedOrigins {
  constructor(private readonly context: () => Promise<AuthContextView>) {}

  async list(request?: Request): Promise<readonly string[]> {
    const context = await this.context();
    const configured = context.options.trustedOrigins;
    const contributed =
      typeof configured === "function" ? await configured(request) : configured;
    const origins = new Set(context.trustedOrigins);
    if (Array.isArray(contributed)) {
      for (const origin of contributed) {
        if (typeof origin === "string" && origin) {
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
