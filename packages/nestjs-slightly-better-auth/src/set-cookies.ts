/** Set-Cookie line handling shared by the built-in platforms' cookie sinks. */
function cookieName(line: string): string {
  const separator = line.indexOf("=");
  return (separator === -1 ? line : line.slice(0, separator)).trim();
}

/** A header value as the list of lines it holds. */
export function headerLines(
  value: string | number | readonly string[] | undefined,
): string[] {
  return Array.isArray(value)
    ? value.map(String)
    : value === undefined
      ? []
      : [String(value)];
}

/**
 * The lines of `values` to append after `existing`. A line identical to the latest line already set for its cookie name
 * changes nothing and is skipped (ADR-09: the kernel's cookie sink de-duplicates identical Set-Cookie values, for example
 * a source that appends a call's cookies that the bridge also forwarded). Any other line is kept, so an identical line
 * after a different one for the same cookie still restores it.
 */
export function setCookieAdditions(
  existing: readonly string[],
  values: readonly string[],
): string[] {
  const latest = new Map<string, string>();
  for (const line of existing) {
    latest.set(cookieName(line), line);
  }
  const additions: string[] = [];
  for (const line of values) {
    const name = cookieName(line);
    if (latest.get(name) === line) {
      continue;
    }
    latest.set(name, line);
    additions.push(line);
  }
  return additions;
}
