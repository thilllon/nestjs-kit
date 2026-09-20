/** Stable Nest injection tokens shared by every package copy and module format. */
function instanceToken(base: string, alias?: string): string {
  return alias === undefined || alias === "" || alias === "default"
    ? base
    : `${base}_${alias}`;
}

export function getBetterAuthInstanceToken(alias?: string): string {
  return instanceToken("NESTJS_SLIGHTLY_BETTER_AUTH_INSTANCE", alias);
}

export function getBetterAuthOptionsToken(alias?: string): string {
  return instanceToken("NESTJS_SLIGHTLY_BETTER_AUTH_OPTIONS", alias);
}

export function getBetterAuthServiceToken(alias?: string): string {
  return instanceToken("NESTJS_SLIGHTLY_BETTER_AUTH_SERVICE", alias);
}

export function getBetterAuthHandleToken(alias?: string): string {
  return instanceToken("NESTJS_SLIGHTLY_BETTER_AUTH_HANDLE", alias);
}
