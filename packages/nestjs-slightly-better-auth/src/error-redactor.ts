/** Inputs come from the active request's owner; the redactor retains no scope. */
export interface ErrorRedactorOptions {
  secrets?: readonly string[];
  headers?: Headers;
  credentialHeaders?: readonly string[];
}

/** Reading an arbitrary thrown value must not invoke another escaping fault. */
export function readErrorProperty(value: unknown, key: PropertyKey): unknown {
  if (
    (typeof value !== "object" || value === null) &&
    typeof value !== "function"
  ) {
    return undefined;
  }
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

export class ErrorRedactor {
  readonly #secrets: readonly string[];

  constructor(options: ErrorRedactorOptions = {}) {
    const values = new Set<string>();
    const add = (value: string) => {
      if (!value) {
        return;
      }
      values.add(value);
      let decoded = value;
      try {
        decoded = decodeURIComponent(value);
        values.add(decoded);
      } catch {
        // Invalid escaping must not prevent redaction of the raw credential.
      }
      for (const form of [value, decoded]) {
        const separator = form.lastIndexOf(".");
        if (separator >= 16) {
          values.add(form.slice(0, separator));
        }
      }
    };
    for (const value of options.secrets ?? []) {
      add(value);
    }
    const headers = options.headers;
    for (const cookie of (headers?.get("cookie") ?? "").split(";")) {
      const separator = cookie.indexOf("=");
      if (separator >= 0) {
        const value = cookie.slice(separator + 1).trim();
        add(value);
        if (value.startsWith('"') && value.endsWith('"')) {
          add(value.slice(1, -1));
        }
      }
    }
    const authorization = headers?.get("authorization");
    if (authorization) {
      add(authorization);
      const credential = /^\S+\s+(.+)$/.exec(authorization)?.[1];
      if (credential) {
        add(credential);
      }
    }
    for (const name of options.credentialHeaders ?? []) {
      const value = headers?.get(name);
      if (value) {
        add(value);
      }
    }
    this.#secrets = [...values].sort(
      (left, right) => right.length - left.length,
    );
  }

  redact(cause: unknown): Error {
    return this.redactCause(cause, 0, new Set());
  }

  private replaceSecrets(value: string): string {
    for (const secret of this.#secrets) {
      value = value.split(secret).join("[REDACTED]");
    }
    return value;
  }

  private diagnostic(value: string): string {
    return this.replaceSecrets(value)
      .split(/[\r\n]/, 1)[0]
      .slice(0, 300);
  }

  private redactCause(
    cause: unknown,
    depth: number,
    seen: Set<unknown>,
  ): Error {
    const message = readErrorProperty(cause, "message");
    const error = new Error(
      this.diagnostic(
        typeof message === "string"
          ? message
          : typeof cause === "string"
            ? cause
            : "Unknown authentication infrastructure failure",
      ),
    );
    const name = readErrorProperty(cause, "name");
    error.name = typeof name === "string" ? this.diagnostic(name) : "Error";
    for (const key of ["code", "errno", "syscall"] as const) {
      const value = readErrorProperty(cause, key);
      if (
        typeof value === "string" ||
        (typeof value === "number" && Number.isFinite(value))
      ) {
        Object.defineProperty(error, key, {
          value: typeof value === "string" ? this.diagnostic(value) : value,
          enumerable: true,
        });
      }
    }
    const stack = readErrorProperty(cause, "stack");
    const frames =
      typeof stack === "string"
        ? stack
            .split(/\r?\n/)
            .filter((line) => /^\s+at .+:\d+:\d+\)?$/.test(line))
            .map((line) => this.replaceSecrets(line))
        : [];
    error.stack = [`${error.name}: ${error.message}`, ...frames].join("\n");
    seen.add(cause);
    const nested = readErrorProperty(cause, "cause");
    if (nested !== undefined && depth < 3 && !seen.has(nested)) {
      Object.defineProperty(error, "cause", {
        value: this.redactCause(nested, depth + 1, seen),
        enumerable: false,
      });
    }
    return error;
  }
}
