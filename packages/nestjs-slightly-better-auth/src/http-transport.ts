import {
  ForbiddenException,
  Get,
  HttpException,
  Inject,
  RequestMethod,
  UnauthorizedException,
} from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import { HttpAdapterHost, MetadataScanner } from "@nestjs/core";
import type { AuthErrorBody, AuthFailure } from "./auth-errors.js";
import { BetterAuthConfigurationError } from "./auth-errors.js";
import type {
  AuthTransport,
  ExtensionRef,
  TransportCall,
  TransportKit,
  TransportValidationContext,
} from "./auth-contracts.js";

/** HTTP controller transport constructed by Nest so denial headers use its adapter. */
export class HttpTransport implements AuthTransport {
  readonly id = "http";

  constructor(
    @Inject(HttpAdapterHost) private readonly adapterHost: HttpAdapterHost,
  ) {}

  handles(context: ExecutionContext): boolean {
    return context.getType() === "http";
  }

  describe(context: ExecutionContext, kit: TransportKit): TransportCall {
    const http = context.switchToHttp();
    const request = http.getRequest<unknown>();
    const response = http.getResponse<unknown>();
    const key = kit.http
      ? kit.http.key(request)
      : typeof request === "object" && request !== null
        ? request
        : context.getArgs();
    const accessor = () => {
      if (!kit.http) {
        throw BetterAuthConfigurationError.atRequest(
          "HTTP_PLATFORM_MISSING",
          "No HTTP platform is available for this request",
          {
            hint: "Register the HTTP platform that supports the application's adapter.",
          },
        );
      }
      return kit.http;
    };
    return {
      key,
      invocation: key,
      headers: () => accessor().headers(request),
      get clientIp() {
        return accessor().clientIp(request);
      },
      get cookies() {
        return accessor().cookieSink(request, response);
      },
      get request() {
        return accessor().request(request);
      },
      param: (name) => accessor().param(request, name),
      get browser() {
        const info = accessor().request(request);
        return {
          enforce: !["GET", "HEAD", "OPTIONS"].includes(
            info.method.toUpperCase(),
          ),
          headers: () => accessor().headers(request),
          url: info.url,
          key,
        };
      },
    };
  }

  toException(failure: AuthFailure, context: ExecutionContext): unknown {
    const adapter = this.adapterHost.httpAdapter;
    const response = context.switchToHttp().getResponse();
    if (adapter && response) {
      if (failure.challenge) {
        adapter.setHeader(response, "WWW-Authenticate", failure.challenge);
      }
      const retryAfter = failure.headers?.get("retry-after");
      if (
        failure.status === 429 &&
        retryAfter !== null &&
        retryAfter !== undefined
      ) {
        adapter.setHeader(response, "Retry-After", retryAfter);
      }
    }
    const body: AuthErrorBody = {
      statusCode: failure.status,
      error:
        failure.status === 401
          ? "Unauthorized"
          : failure.status === 403
            ? "Forbidden"
            : "Too Many Requests",
      code: failure.code,
      ...(failure.reason ? { reason: failure.reason } : {}),
      message: failure.message,
    };
    if (failure.status === 401) {
      return new UnauthorizedException(body);
    }
    if (failure.status === 403) {
      return new ForbiddenException(body);
    }
    return new HttpException(body, 429);
  }

  validate(context: TransportValidationContext): void {
    class Probe {
      route(): void {}
    }
    Get("/nsba-canary/:id")(
      Probe.prototype,
      "route",
      Object.getOwnPropertyDescriptor(Probe.prototype, "route")!,
    );
    if (
      Reflect.getMetadata("path", Probe.prototype.route) !==
        "/nsba-canary/:id" ||
      Reflect.getMetadata("method", Probe.prototype.route) !== RequestMethod.GET
    ) {
      throw new BetterAuthConfigurationError(
        "NEST_METADATA_KEY_CHANGED",
        "Nest HTTP route metadata failed its path/method canary",
      );
    }
    const scanner = new MetadataScanner();
    for (const wrapper of context.discovery.getControllers()) {
      const target = wrapper.metatype;
      if (!target?.prototype || wrapper.isAlias) {
        continue;
      }
      const controllerPaths: unknown = Reflect.getMetadata("path", target);
      for (const method of scanner.getAllMethodNames(target.prototype)) {
        const handler: unknown = target.prototype[method];
        if (
          typeof handler !== "function" ||
          Reflect.getMetadata("method", handler) === undefined
        ) {
          continue;
        }
        const handlerPaths: unknown = Reflect.getMetadata("path", handler);
        const paths = [controllerPaths, handlerPaths].flatMap(
          (value): string[] =>
            typeof value === "string"
              ? [value]
              : Array.isArray(value)
                ? value.filter(
                    (item): item is string => typeof item === "string",
                  )
                : [],
        );
        const inputs = [
          ...new Set(
            paths.flatMap((path) =>
              [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1]!),
            ),
          ),
        ];
        context.claim(target, method, "global", {
          code: "ROUTE_UNGUARDED",
          inputs,
          hint: "Register the global guard (globalGuard: true) or add @UseBetterAuth() to the controller.",
        });
      }
    }
  }
}

export function httpTransport(): ExtensionRef<AuthTransport> {
  return HttpTransport;
}
