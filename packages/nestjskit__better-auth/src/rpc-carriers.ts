import type { ExecutionContext } from "@nestjs/common";
import * as microservices from "@nestjs/microservices";
import { AuthFailures, type AuthFailure } from "./auth-errors.js";

export interface RpcCredentialCarrier {
  readonly id: string;
  matches(context: ExecutionContext): boolean;
  headers(context: ExecutionContext): HeadersInit | undefined;
  toException?(failure: AuthFailure, context: ExecutionContext): unknown;
}

const credentialNames = ["authorization", "cookie", "x-api-key"] as const;

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}
function method(
  value: unknown,
  name: string,
): ((...args: unknown[]) => unknown) | undefined {
  const target = record(value);
  const candidate = target?.[name];
  return typeof candidate === "function" ? candidate.bind(value) : undefined;
}
function contextOf(context: ExecutionContext): unknown {
  return context.switchToRpc().getContext<unknown>();
}
function extract(input: unknown, allow: readonly string[]): Headers {
  const headers = new Headers();
  const allowed = new Set(allow.map((name) => name.toLowerCase()));
  // Host and forwarding metadata must never influence hostless authentication.
  for (const name of [
    "host",
    "x-forwarded-host",
    "x-forwarded-proto",
    "set-cookie",
  ]) {
    allowed.delete(name);
  }
  const source = record(input);
  if (!source) {
    return headers;
  }
  for (const name of Object.keys(source)) {
    const normalized = name.toLowerCase();
    if (!allowed.has(normalized)) {
      continue;
    }
    const value = source[name];
    const values = Array.isArray(value) ? value : [value];
    if (values.length === 0) {
      throw AuthFailures.rejected({
        status: 401,
        reason: "MALFORMED_CREDENTIALS",
      });
    }
    for (const item of values) {
      const text =
        typeof item === "string"
          ? item
          : Buffer.isBuffer(item)
            ? item.toString("utf8")
            : undefined;
      if (text === undefined || /[\r\n\0]/.test(text)) {
        throw AuthFailures.rejected({
          status: 401,
          reason: "MALFORMED_CREDENTIALS",
        });
      }
      try {
        headers.append(normalized, text);
      } catch {
        // Web Headers errors can embed credentials in their message. Never retain
        // that error, and never discard one bad credential to try another one.
        throw AuthFailures.rejected({
          status: 401,
          reason: "MALFORMED_CREDENTIALS",
        });
      }
    }
  }
  return headers;
}

export function grpcCarrier(
  options: { metadata?: readonly string[] } = {},
): RpcCredentialCarrier {
  return {
    id: "grpc",
    matches: (context) =>
      !!method(context.getArgByIndex(1), "get") &&
      !!method(context.getArgByIndex(1), "getMap"),
    headers: (context) =>
      extract(
        method(context.getArgByIndex(1), "getMap")?.(),
        options.metadata ?? credentialNames,
      ),
    toException(failure) {
      const name =
        failure.status === 401
          ? "GrpcUnauthenticatedException"
          : failure.status === 403
            ? "GrpcPermissionDeniedException"
            : "GrpcResourceExhaustedException";
      const Native = (
        microservices as unknown as Record<
          string,
          new (
            message: string,
          ) => Error & { getError(): object }
        >
      )[name];
      // Native gRPC exceptions require an opt-in Nest filter. Wrap their payload
      // so the default RPC filter also delivers the numeric status.
      return new microservices.RpcException(
        Native
          ? new Native(failure.message).getError()
          : {
              code:
                failure.status === 401 ? 16 : failure.status === 403 ? 7 : 8,
              message: failure.message,
            },
      );
    },
  };
}

export function natsCarrier(
  options: { headers?: readonly string[] } = {},
): RpcCredentialCarrier {
  return {
    id: "nats",
    matches: (context) => !!method(contextOf(context), "getHeaders"),
    headers(context) {
      const input = method(contextOf(context), "getHeaders")?.();
      const keys = method(input, "keys")?.();
      const get = method(input, "get");
      const values: RecordValue = Object.create(null);
      if (Array.isArray(keys) && get) {
        for (const key of keys) {
          if (typeof key === "string") {
            values[key] = get(key);
          }
        }
      }
      return extract(values, options.headers ?? credentialNames);
    },
  };
}

export function kafkaCarrier(
  options: { headers?: readonly string[] } = {},
): RpcCredentialCarrier {
  const message = (context: ExecutionContext) =>
    record(method(contextOf(context), "getMessage")?.());
  return {
    id: "kafka",
    matches: (context) =>
      message(context) !== undefined && "headers" in message(context)!,
    headers: (context) =>
      extract(message(context)?.headers, options.headers ?? credentialNames),
  };
}

export function rmqCarrier(
  options: { headers?: readonly string[] } = {},
): RpcCredentialCarrier {
  const message = (context: ExecutionContext) =>
    record(method(contextOf(context), "getMessage")?.());
  return {
    id: "rmq",
    matches: (context) =>
      message(context) !== undefined && "properties" in message(context)!,
    headers: (context) =>
      extract(
        record(message(context)?.properties)?.headers,
        options.headers ?? credentialNames,
      ),
  };
}

export function mqttCarrier(
  options: { userProperties?: readonly string[] } = {},
): RpcCredentialCarrier {
  return {
    id: "mqtt",
    matches: (context) => !!method(contextOf(context), "getPacket"),
    headers: (context) =>
      extract(
        record(record(method(contextOf(context), "getPacket")?.())?.properties)
          ?.userProperties,
        options.userProperties ?? credentialNames,
      ),
  };
}

export function payloadCarrier(
  options: { field?: string } = {},
): RpcCredentialCarrier {
  const payload = (context: ExecutionContext) => {
    const data = record(context.switchToRpc().getData<unknown>());
    const field = options.field ?? "auth";
    return data && Object.hasOwn(data, field) ? record(data[field]) : undefined;
  };
  return {
    id: "payload",
    matches: (context) => payload(context) !== undefined,
    headers: (context) => extract(payload(context), credentialNames),
  };
}

export const defaultCarriers: readonly RpcCredentialCarrier[] = Object.freeze([
  grpcCarrier(),
  natsCarrier(),
  kafkaCarrier(),
  rmqCarrier(),
  mqttCarrier(),
  payloadCarrier(),
]);
