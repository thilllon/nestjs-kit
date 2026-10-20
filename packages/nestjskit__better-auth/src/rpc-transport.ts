import { Logger, type ExecutionContext } from "@nestjs/common";
import { MetadataScanner } from "@nestjs/core";
import { MessagePattern, RpcException } from "@nestjs/microservices";
import type {
  AuthTransport,
  BootAdvice,
  ExtensionRef,
  TransportCall,
  TransportValidationContext,
} from "./auth-contracts.js";
import {
  BetterAuthConfigurationError,
  AuthFailures,
  type AuthFailure,
} from "./auth-errors.js";
import {
  defaultCarriers,
  grpcCarrier,
  type RpcCredentialCarrier,
} from "./rpc-carriers.js";

export interface RpcTransportOptions {
  carriers?: readonly RpcCredentialCarrier[];
  hybridCoverage?: "error" | "warn" | "off";
  inheritAppConfig?: boolean;
}

export function rpcTransport(
  options: RpcTransportOptions = {},
): ExtensionRef<AuthTransport> {
  const carriers = [...(options.carriers ?? defaultCarriers)];
  const select = (context: ExecutionContext) =>
    carriers.find((carrier) => carrier.matches(context));
  const grpc = grpcCarrier();
  return {
    id: "rpc",
    requires: { hostlessCalls: true },
    handles: (context) => context.getType() === "rpc",
    describe(context): TransportCall {
      const candidate = context.switchToRpc().getContext<unknown>();
      const key =
        candidate !== null && typeof candidate === "object"
          ? candidate
          : context.getArgs();
      return {
        key,
        invocation: key,
        cookies: null,
        clientIp: null,
        headers() {
          const input = select(context)?.headers(context);
          try {
            return new Headers(input);
          } catch {
            // Custom carriers may return a raw HeadersInit. Conversion errors
            // include its values, so discard the original error and its cause.
            throw AuthFailures.rejected({
              status: 401,
              reason: "MALFORMED_CREDENTIALS",
            });
          }
        },
        param(name) {
          const data = context.switchToRpc().getData<unknown>();
          return data !== null &&
            typeof data === "object" &&
            Object.hasOwn(data, name)
            ? (data as Record<string, unknown>)[name]
            : undefined;
        },
      };
    },
    toException(failure: AuthFailure, context) {
      const carrier = select(context);
      return carrier?.toException
        ? carrier.toException(failure, context)
        : new RpcException({
            status: "error",
            statusCode: failure.status,
            code: failure.code,
            ...(failure.reason ? { reason: failure.reason } : {}),
            message: failure.message,
          });
    },
    toInternalException(error, context, info) {
      if (!grpc.matches(context)) {
        return error;
      }
      if (!info.repeated) {
        new Logger("BetterAuthRpc").error(error);
      }
      return new RpcException({ code: 13, message: "Internal server error" });
    },
    validate(context: TransportValidationContext) {
      class Probe {
        handler(): void {}
      }
      MessagePattern("nsba-probe")(
        Probe.prototype,
        "handler",
        Object.getOwnPropertyDescriptor(Probe.prototype, "handler")!,
      );
      const patterns: unknown = Reflect.getMetadata(
        "microservices:pattern",
        Probe.prototype.handler,
      );
      if (!Array.isArray(patterns) || patterns[0] !== "nsba-probe") {
        throw new BetterAuthConfigurationError(
          "NEST_METADATA_KEY_CHANGED",
          "Nest RPC pattern metadata failed its canary",
        );
      }
      const explicit = context.hasHttpAdapter && !options.inheritAppConfig;
      const scanner = new MetadataScanner();
      for (const wrapper of context.discovery.getControllers()) {
        const target = wrapper.metatype;
        if (!target?.prototype || wrapper.isAlias) {
          continue;
        }
        for (const name of scanner.getAllMethodNames(target.prototype)) {
          if (
            Reflect.getMetadata(
              "microservices:pattern",
              target.prototype[name],
            ) === undefined
          ) {
            continue;
          }
          context.claim(target, name, explicit ? "explicit" : "global", {
            code: "RPC_HANDLER_UNGUARDED",
            everyHandler: explicit,
            coverage: explicit ? (options.hybridCoverage ?? "error") : "error",
            hint: "Add @UseBetterAuth() or @Public() to the RPC controller/handler, or assert inheritAppConfig and pass { inheritAppConfig: true } to every connectMicroservice call.",
          });
        }
      }
    },
    advise(): readonly BootAdvice[] {
      return options.inheritAppConfig
        ? [
            {
              level: "warn",
              code: "W_RPC_INHERIT_APP_CONFIG_ASSERTED",
              message:
                "RPC coverage assumes every connectMicroservice() call passes { inheritAppConfig: true }. Prefer @UseBetterAuth() on message controllers for verifiable coverage.",
            },
          ]
        : [];
    },
  } satisfies AuthTransport;
}
