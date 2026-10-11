// Join points of one invocation.

import { findAnnotation } from "./annotation";
import { AspectUsageError } from "./errors";
import { introduced } from "./introduction";
import type {
  AnnotationLike,
  AnyShape,
  Class,
  JoinPoint,
  MethodInvocation,
  ProceedingJoinPoint,
} from "./types";

const MAX_STRING_LENGTH = 32;

function describeAnnotation(annotation: AnnotationLike<any>): string {
  const name = (annotation as { annotationName?: unknown }).annotationName;
  return typeof name === "string" ? `@${name}` : "the annotation";
}

/**
 * Join point of one invocation.
 * - `kind`, `signature` and `isAsync` come from `invocation.method`; `target`
 *   and `args` from the invocation.
 * - `annotation` and `findAnnotation` use `findAnnotation` of
 *   `./annotation` (the method, the declaring class, the target class);
 *   `annotation` raises `AspectUsageError` when nothing is found.
 * - `introduced` is `introduced(target, token)` of `./introduction`.
 * - `toString()` is `"<TargetType>.<name>(<args>)"`, with the arguments
 *   rendered by `formatArgument`.
 */
export function createJoinPoint(
  invocation: MethodInvocation,
): JoinPoint<AnyShape> {
  const { method } = invocation;
  const joinPoint: JoinPoint<AnyShape> = {
    kind: method.kind,
    target: invocation.target,
    args: invocation.args,
    signature: {
      name: method.name,
      declaringType: method.declaringType,
      targetType: method.targetType,
    },
    isAsync: method.isAsync,
    annotation(annotation: AnnotationLike<any>) {
      const match = findAnnotation(annotation, method);
      if (!match) {
        throw new AspectUsageError(
          `${joinPoint.toString()} does not carry ${describeAnnotation(annotation)}; use findAnnotation() when the pointcut does not guarantee it`,
        );
      }
      return match.value as never;
    },
    findAnnotation(annotation: AnnotationLike<any>) {
      return findAnnotation(annotation, method)?.value as never;
    },
    introduced<I extends object>(token: Class<I>): I {
      return introduced(invocation.target, token);
    },
    toString() {
      const args = invocation.args.map(formatArgument).join(", ");
      return `${method.targetType.name}.${String(method.name)}(${args})`;
    },
  };
  return joinPoint;
}

/**
 * Join point of around advice. `proceed()` runs
 * `invocation.cloneFromHere().proceed()` and `proceedWith(...args)` runs
 * `invocation.cloneFromHere(args).proceed()`, so both can be called any number
 * of times.
 */
export function createProceedingJoinPoint(
  invocation: MethodInvocation,
): ProceedingJoinPoint<AnyShape> {
  return {
    ...createJoinPoint(invocation),
    proceed() {
      return invocation.cloneFromHere().proceed();
    },
    proceedWith(...args: readonly unknown[]) {
      return invocation.cloneFromHere(args).proceed();
    },
  };
}

function ownDataProperty(value: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function constructorName(value: object): string {
  const prototype: object | null = Object.getPrototypeOf(value);
  if (!prototype) {
    return "Object";
  }
  const ctor = ownDataProperty(prototype, "constructor");
  const name = typeof ctor === "function" ? ownDataProperty(ctor, "name") : "";
  return typeof name === "string" && name !== "" ? name : "Object";
}

/**
 * Short rendering of one argument for `JoinPoint.toString()`: primitives as
 * literals (strings quoted and truncated), functions as `[Function name]`,
 * arrays as `Array(n)`, other objects as their constructor name. It never
 * calls user code such as `toJSON` or `toString`.
 */
export function formatArgument(value: unknown): string {
  switch (typeof value) {
    case "string":
      return JSON.stringify(
        value.length > MAX_STRING_LENGTH
          ? `${value.slice(0, MAX_STRING_LENGTH)}...`
          : value,
      );
    case "bigint":
      return `${value}n`;
    case "function": {
      const name = ownDataProperty(value, "name");
      return typeof name === "string" && name !== ""
        ? `[Function ${name}]`
        : "[Function]";
    }
    case "object":
      break;
    default:
      return String(value);
  }
  if (value === null) {
    return "null";
  }
  try {
    if (Array.isArray(value)) {
      return `Array(${value.length})`;
    }
    return constructorName(value);
  } catch {
    // A revoked proxy throws on inspection.
    return "Object";
  }
}
