import { IntrinsicException } from "@nestjs/common";
import type {
  InvocationLineage,
  PrincipalReading,
  PrincipalResult,
  RoutePlan,
  TransportCall,
} from "./auth-contracts.js";
import {
  BetterAuthConfigurationError,
  isConfigurationError,
} from "./auth-errors.js";
import type { AuthPrincipal } from "./auth-types.js";
import { RequestScope } from "./request-scope.js";

const RESOLUTION = Symbol.for("nestjs-slightly-better-auth:resolution");
const TEST_STAMP = Symbol.for("nestjs-slightly-better-auth:test-stamp");
interface Records {
  own: Map<string, PrincipalReading>;
  positions: Map<string, PrincipalReading>;
  lineage?: InvocationLineage;
  invocationLineage?: InvocationLineage;
}
interface TestStamp {
  elements: readonly unknown[];
  results: Map<string, PrincipalResult>;
}
export interface ReadingInput {
  readonly args: readonly unknown[];
  readonly call?: TransportCall;
  readonly lineage?: InvocationLineage;
  readonly plan?: Pick<RoutePlan, "access" | "instance" | "site">;
  readonly beforeGuard?: boolean;
  readonly site?: string;
}

function object(value: unknown): value is object {
  return (
    value !== null && (typeof value === "object" || typeof value === "function")
  );
}
function records(target: object, create = false): Records | undefined {
  let value = Reflect.get(target, RESOLUTION) as Records | undefined;
  if (!value && create) {
    value = { own: new Map(), positions: new Map() };
    Object.defineProperty(target, RESOLUTION, { value });
  }
  return value;
}
function sameElements(stamp: TestStamp, args: readonly unknown[]): boolean {
  return (
    stamp.elements.length === args.length &&
    stamp.elements.every((value, index) => value === args[index])
  );
}

/**
 * The stamp of this invocation: the one on the args array itself (WS, RPC and GraphQL guards and interceptors share
 * that array), or one on its elements when the elements identify the invocation. That takes at least two object
 * elements (an HTTP request and its response): a lone object, such as a WS socket beside a primitive payload, is shared
 * by every message on its connection, so a stamp found only through it may belong to another invocation.
 */
function matchingStamp(args: readonly unknown[]): TestStamp | undefined {
  const own = Reflect.get(args, TEST_STAMP) as TestStamp | undefined;
  if (own && sameElements(own, args)) {
    return own;
  }
  const objects = args.filter(object);
  if (objects.length < 2) {
    return undefined;
  }
  for (const target of objects) {
    const stamp = Reflect.get(target, TEST_STAMP) as TestStamp | undefined;
    if (stamp && sameElements(stamp, args)) {
      return stamp;
    }
  }
  return undefined;
}

function lineageFromArgs(
  args: readonly unknown[],
): InvocationLineage | undefined {
  const targets = [args, ...args.filter(object)];
  for (const target of targets) {
    const own = records(target)?.invocationLineage;
    if (own) {
      return own;
    }
  }
  for (const target of targets) {
    const carrier = records(target)?.lineage;
    if (!carrier) {
      continue;
    }
    // The recorded callback is structural, but its recorded position may belong
    // to a sibling operation in the same batched GraphQL carrier.
    for (const position of carrier.enclosing(args)) {
      return { ...carrier, position };
    }
  }
  return undefined;
}

/** The intrinsic twin suppresses Nest's repeated log, while retaining the safe wire shape. */
export class RepeatedReaderError extends IntrinsicException {
  constructor(error: BetterAuthConfigurationError) {
    super(error.message);
    Object.defineProperties(this, Object.getOwnPropertyDescriptors(error));
  }
}

export class PrincipalReadings {
  constructor(private readonly scope: RequestScope) {}

  record(
    call: Pick<TransportCall, "invocation" | "lineage">,
    reading: PrincipalReading,
  ): void {
    const record = records(call.invocation, true)!;
    record.own.set(reading.instance, reading);
    if (call.lineage) {
      record.invocationLineage = call.lineage;
      this.recordLineage(call.lineage, reading);
    }
  }

  recordLineage(lineage: InvocationLineage, reading: PrincipalReading): void {
    const value = records(lineage.carrier, true)!;
    value.positions.set(lineage.position, reading);
    value.lineage = lineage;
  }

  enclosing(
    lineage: InvocationLineage,
    args: readonly unknown[],
  ): PrincipalReading | undefined {
    const positions = records(lineage.carrier)?.positions;
    for (const position of lineage.enclosing(args)) {
      const reading = positions?.get(position);
      if (reading) {
        return reading;
      }
    }
    return undefined;
  }

  read(input: ReadingInput): PrincipalReading {
    const { plan, args, call } = input;
    const lineage = input.lineage ?? call?.lineage;
    let resolvedInstance = plan?.instance;
    try {
      if (plan?.access === "public") {
        return { outcome: "no-identity", instance: plan.instance };
      }
      let reading: PrincipalReading | undefined;
      let validation = lineage ?? lineageFromArgs(args);
      if (plan?.access === "inherit") {
        reading = lineage && this.enclosing(lineage, args);
      } else {
        const targets = call
          ? [call.invocation]
          : [args, ...args.filter(object)];
        for (const target of targets) {
          const own = records(target)?.own;
          reading = plan
            ? own?.get(plan.instance)
            : own?.size === 1
              ? own.values().next().value
              : undefined;
          if (reading) {
            break;
          }
        }
        if (!reading && !plan) {
          for (const target of [args, ...args.filter(object)]) {
            const candidate = records(target)?.lineage;
            if (!candidate) {
              continue;
            }
            reading = this.enclosing(candidate, args);
            if (reading) {
              validation = candidate;
              break;
            }
          }
        }
      }
      if (!reading) {
        const stamp = matchingStamp(args);
        const instance = plan?.instance ?? "default";
        const result = stamp?.results.get(instance);
        if (result) {
          reading = { ...result, instance };
        }
      }
      if (!reading) {
        throw BetterAuthConfigurationError.atRequest(
          input.beforeGuard && plan?.access !== "inherit"
            ? "PRINCIPAL_READ_BEFORE_GUARD"
            : "NO_AUTH_RESULT",
          "No authentication result: BetterAuthGuard did not run for this invocation",
          {
            site: plan?.site ?? input.site,
            hint: "Run BetterAuthGuard before reading a principal; test replacements must stampPrincipal().",
          },
        );
      }
      resolvedInstance = reading.instance;
      if (reading.outcome === "authenticated") {
        validation?.assertReadable?.(args);
      }
      return reading;
    } catch (error) {
      if (isConfigurationError(error)) {
        throw this.deliver(error, input, resolvedInstance);
      }
      throw error;
    }
  }

  current(): PrincipalReading {
    const state = this.scope.current();
    if (!state?.reading) {
      throw BetterAuthConfigurationError.atRequest(
        "NO_AUTH_SCOPE",
        "Principal readers require a handler scope",
      );
    }
    return state.reading();
  }

  project<T>(
    reading: PrincipalReading,
    spec: {
      kind?: string;
      reason?: string;
      site: string;
      project: (principal: AuthPrincipal) => T;
    },
    input?: ReadingInput,
  ): T | null {
    if (reading.outcome === "no-identity" || reading.outcome === "absent") {
      return null;
    }
    if (reading.outcome === "rejected") {
      throw reading.failure;
    }
    if (spec.kind && reading.principal.kind !== spec.kind) {
      const error = BetterAuthConfigurationError.atRequest(
        spec.reason ?? "PRINCIPAL_KIND_REQUIRED",
        `This reader requires principal kind ${spec.kind}`,
        {
          site: spec.site,
          hint: "Use @CurrentPrincipal() or getPrincipal() and narrow p.kind.",
        },
      );
      throw this.deliver(error, input, reading.instance);
    }
    return spec.project(reading.principal);
  }

  deliver(
    error: BetterAuthConfigurationError,
    input?: ReadingInput,
    instance?: string,
  ): BetterAuthConfigurationError | RepeatedReaderError {
    const state = this.scope.current();
    const call = state?.call ?? input?.call;
    const lineage =
      call?.lineage ?? input?.lineage ?? (input && lineageFromArgs(input.args));
    const key = call?.key ?? lineage?.carrier ?? input?.args;
    if (!key) {
      return error;
    }
    const repeated = this.scope.surfaced(key, error, {
      instance:
        instance ?? state?.plan?.instance ?? input?.plan?.instance ?? "default",
      site:
        error.site ?? input?.site ?? input?.plan?.site ?? "principal reader",
      lineage,
    });
    return repeated ? new RepeatedReaderError(error) : error;
  }

  stamp(
    args: readonly unknown[],
    instance: string,
    result: PrincipalResult,
  ): void {
    stampResult(args, instance, result);
  }
}

/** Test stamps are verified by array or element identity (see matchingStamp), so a stamp never leaks into another invocation. */
export function stampResult(
  args: readonly unknown[],
  instance: string,
  result: PrincipalResult,
): void {
  const stamp = matchingStamp(args) ?? {
    elements: [...args],
    results: new Map(),
  };
  stamp.results.set(instance, result);
  for (const target of [args, ...args]) {
    if (object(target) && Object.isExtensible(target)) {
      Object.defineProperty(target, TEST_STAMP, {
        value: stamp,
        configurable: true,
      });
    }
  }
}

export function stampedReading(
  args: readonly unknown[],
  instance: string,
): PrincipalReading | undefined {
  const result = matchingStamp(args)?.results.get(instance);
  return result ? { ...result, instance } : undefined;
}
