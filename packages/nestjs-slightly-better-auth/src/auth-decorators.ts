import {
  applyDecorators,
  createParamDecorator,
  SetMetadata,
  UseGuards,
  UseInterceptors,
  type ExecutionContext,
} from "@nestjs/common";
import type {
  DatabaseHookTarget,
  DbHookMethodDecorator,
  DbHookOptions,
  HookMethodDecorator,
  HookOptions,
  HookPredicate,
  PolicyRef,
  PrincipalReading,
  Requirement,
  RequirementExpr,
  RequirementOptions,
} from "./auth-contracts.js";
import type {
  EndpointPath,
  PrincipalKind,
  PrincipalOfKind,
} from "./auth-types.js";
import { BetterAuthConfigurationError } from "./auth-errors.js";
import * as tokens from "./auth-tokens.js";
import { BetterAuthGuard } from "./auth-guard.js";
import { BetterAuthScopeInterceptor } from "./auth-scope-interceptor.js";
import { PrincipalReadings } from "./principal-readings.js";
import { RequestScope } from "./request-scope.js";

function append(target: object, key: symbol, value: unknown): void {
  Reflect.defineMetadata(
    key,
    Object.freeze([...(Reflect.getOwnMetadata(key, target) ?? []), value]),
    target,
  );
}
export const Public = () => SetMetadata(tokens.ACCESS_METADATA, "public");
export const OptionalAuth = () =>
  SetMetadata(tokens.ACCESS_METADATA, "optional");
export const RequireAuth = (options?: { authoritative?: boolean }) =>
  applyDecorators(
    SetMetadata(tokens.ACCESS_METADATA, "required"),
    SetMetadata(tokens.FRESHNESS_METADATA, options?.authoritative === true),
  );
export const UseAuthInstance = (name: string) =>
  SetMetadata(tokens.AUTH_INSTANCE_METADATA, name);
export const AcceptPrincipals = (
  ...kinds: readonly [PrincipalKind, ...PrincipalKind[]]
) => SetMetadata(tokens.ACCEPT_PRINCIPALS_METADATA, Object.freeze([...kinds]));
export const SkipDefaultRequirements = () =>
  SetMetadata(tokens.SKIP_DEFAULT_REQUIREMENTS_METADATA, true);
export const ForwardAuthCookies = (enabled = true) =>
  SetMetadata(tokens.FORWARD_COOKIES_METADATA, enabled);
export const SkipOriginCheck = () =>
  SetMetadata(tokens.SKIP_ORIGIN_CHECK_METADATA, true);
export const UseBetterAuth = () =>
  applyDecorators(
    SetMetadata(tokens.USE_BETTER_AUTH_METADATA, true),
    UseGuards(BetterAuthGuard),
    UseInterceptors(BetterAuthScopeInterceptor),
  );
export function Require(
  ...requirements: readonly RequirementExpr[]
): ClassDecorator & MethodDecorator {
  return (
    target: object,
    _key?: string | symbol,
    descriptor?: PropertyDescriptor,
  ) => {
    for (const expression of requirements) {
      append(
        descriptor?.value ?? target,
        tokens.REQUIREMENTS_METADATA,
        expression,
      );
    }
  };
}
export const anyOf = (
  ...requirements: readonly RequirementExpr[]
): RequirementExpr => ({ anyOf: requirements });
export const allOf = (
  ...requirements: readonly RequirementExpr[]
): RequirementExpr => ({ allOf: requirements });
export const requirement = <P>(
  policy: PolicyRef<P>,
  params: P,
  options?: RequirementOptions,
): Requirement<P> => ({ policy, params, ...options });

export interface ReaderContext {
  readonly args: readonly unknown[];
  readonly readings: PrincipalReadings;
  readonly scope: RequestScope;
  readonly reading?: () => PrincipalReading;
}
export function readerContext(context: ExecutionContext): ReaderContext {
  const args = context.getArgs();
  for (const arg of [args, ...args]) {
    if (
      (typeof arg !== "object" || arg === null) &&
      typeof arg !== "function"
    ) {
      continue;
    }
    const bridge = Reflect.get(arg, tokens.READER_CONTEXT) as
      | ReaderContext
      | undefined;
    if (
      bridge &&
      bridge.args.length === args.length &&
      bridge.args.every((value, index) => value === args[index]) &&
      bridge.reading !== undefined &&
      bridge.scope.current()?.reading === bridge.reading
    ) {
      return bridge;
    }
  }
  // No application state is created or retained by a DI-free lineage-only reader.
  const scope = new RequestScope();
  return { args, scope, readings: new PrincipalReadings(scope) };
}
function principalParam(spec?: {
  kind: string;
  reason: string;
  project: (p: any) => unknown;
}): ParameterDecorator {
  const decorator = createParamDecorator(
    (_data: unknown, context: ExecutionContext) => {
      const bridge = readerContext(context);
      const input = {
        args: context.getArgs(),
        site: `${context.getClass().name}.${context.getHandler().name}`,
      };
      const reading =
        bridge.reading !== undefined &&
        bridge.scope.current()?.reading === bridge.reading
          ? bridge.readings.current()
          : bridge.readings.read(input);
      return bridge.readings.project(
        reading,
        { ...spec, site: input.site, project: spec?.project ?? ((p) => p) },
        input,
      );
    },
  )();
  return (target, propertyKey, index) => {
    if (propertyKey === undefined) {
      throw new BetterAuthConfigurationError(
        "PRINCIPAL_PARAM_TARGET",
        "Principal parameters require a handler method",
      );
    }
    const handler = Reflect.get(target, propertyKey);
    append(handler, tokens.PRINCIPAL_PARAMS_METADATA, {
      index,
      ...(spec ? { kind: spec.kind, reason: spec.reason } : {}),
    });
    decorator(target, propertyKey, index);
  };
}
export const CurrentPrincipal = (): ParameterDecorator => principalParam();
export function definePrincipalParam<K extends PrincipalKind, R>(spec: {
  readonly kind: K;
  readonly reason: string;
  readonly project: (principal: PrincipalOfKind<K>) => R;
}): () => ParameterDecorator {
  return () => principalParam(spec);
}
export function defineInvocationParam(
  slot: symbol,
  spec: { readonly missing: string },
): () => ParameterDecorator {
  return () => {
    const decorator = createParamDecorator(
      (_data: unknown, context: ExecutionContext) => {
        const bridge = readerContext(context);
        const state = bridge.scope.current();
        const input = {
          args: context.getArgs(),
          site: `${context.getClass().name}.${context.getHandler().name}`,
        };
        const reading = state?.reading
          ? bridge.readings.current()
          : bridge.readings.read(input);
        const candidates = state?.call
          ? [state.call.invocation]
          : [input.args, ...input.args];
        for (const candidate of candidates) {
          if (
            !candidate ||
            (typeof candidate !== "object" && typeof candidate !== "function")
          ) {
            continue;
          }
          const values = Reflect.get(candidate, tokens.INVOCATION_VALUES) as
            | Map<string, Map<symbol, unknown>>
            | undefined;
          if (values?.get(reading.instance)?.has(slot)) {
            return values.get(reading.instance)!.get(slot);
          }
        }
        throw bridge.readings.deliver(
          BetterAuthConfigurationError.atRequest(
            "NO_INVOCATION_VALUE",
            spec.missing,
            { site: input.site },
          ),
          input,
          reading.instance,
        );
      },
    )();
    return (target, key, index) => {
      if (key === undefined) {
        throw new BetterAuthConfigurationError(
          "INVOCATION_PARAM_TARGET",
          "Invocation parameters require a handler method",
        );
      }
      append(Reflect.get(target, key), tokens.INVOCATION_PARAMS_METADATA, {
        index,
        slot,
        missing: spec.missing,
      });
      decorator(target, key, index);
    };
  };
}
export interface EndpointHookDeclaration {
  readonly phase: "before" | "after";
  readonly match: string | readonly string[] | HookPredicate | undefined;
  readonly options: Readonly<HookOptions>;
  readonly method: string | symbol;
  // biome-ignore lint/complexity/noBannedTypes: Nest handler metadata preserves the framework function identity.
  readonly handler: Function;
  readonly declarationOrder: number;
}
export interface DatabaseHookDeclaration {
  readonly phase: "before" | "after";
  readonly target: DatabaseHookTarget;
  readonly options: Readonly<DbHookOptions>;
  readonly method: string | symbol;
  // biome-ignore lint/complexity/noBannedTypes: Nest handler metadata preserves the framework function identity.
  readonly handler: Function;
  readonly declarationOrder: number;
}
// biome-ignore lint/complexity/noBannedTypes: Nest handler metadata preserves the framework function identity.
export function readHookMetadata(handler: Function): {
  readonly hooks: readonly EndpointHookDeclaration[];
  readonly databaseHooks: readonly DatabaseHookDeclaration[];
} {
  return {
    hooks: Reflect.getOwnMetadata(tokens.HOOK_METADATA, handler) ?? [],
    databaseHooks:
      Reflect.getOwnMetadata(tokens.DB_HOOK_METADATA, handler) ?? [],
  };
}
function hook<P extends string>(
  phase: "before" | "after",
  match?: P | readonly P[] | HookPredicate,
  options?: HookOptions,
): HookMethodDecorator<P> {
  return (_target, method, descriptor) => {
    const handler = descriptor.value!;
    const records = readHookMetadata(handler).hooks;
    append(
      handler,
      tokens.HOOK_METADATA,
      Object.freeze({
        phase,
        match: Array.isArray(match) ? Object.freeze([...match]) : match,
        options: Object.freeze({ ...options }),
        method,
        handler,
        declarationOrder: records.length,
      }),
    );
  };
}
export const BeforeAuth = <const P extends EndpointPath | (string & {})>(
  match?: P | readonly P[] | HookPredicate,
  options?: HookOptions,
): HookMethodDecorator<P> => hook("before", match, options);
export const AfterAuth = <const P extends EndpointPath | (string & {})>(
  match?: P | readonly P[] | HookPredicate,
  options?: HookOptions,
): HookMethodDecorator<P> => hook("after", match, options);
function databaseHook<
  E extends DatabaseHookTarget,
  Ph extends "before" | "after",
>(phase: Ph, target: E, options?: DbHookOptions): DbHookMethodDecorator<E, Ph> {
  return (_prototype, method, descriptor) => {
    const handler = descriptor.value!;
    append(
      handler,
      tokens.DB_HOOK_METADATA,
      Object.freeze({
        phase,
        target,
        options: Object.freeze({ ...options }),
        method,
        handler,
        declarationOrder: readHookMetadata(handler).databaseHooks.length,
      }),
    );
  };
}
export const BeforeDatabase = <E extends DatabaseHookTarget>(
  target: E,
  options?: DbHookOptions,
): DbHookMethodDecorator<E, "before"> =>
  databaseHook("before", target, options);
export const AfterDatabase = <E extends DatabaseHookTarget>(
  target: E,
  options?: DbHookOptions,
): DbHookMethodDecorator<E, "after"> => databaseHook("after", target, options);
