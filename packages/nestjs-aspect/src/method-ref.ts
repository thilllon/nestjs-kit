// Shared: owned by the architect, implemented and frozen. Builds the matching
// input (`ClassRef`, `MethodRef`) that pointcuts, the chain builder and the
// weaver share.

import "reflect-metadata";
import { AopConfigurationError } from "./errors";
import type {
  BeanRef,
  Class,
  ClassRef,
  Fn,
  JoinPointKind,
  MethodRef,
} from "./types";

/**
 * Own property of a dispatcher stub that holds the function it replaced.
 * `createMethodRef` reads it so that a woven prototype describes the same
 * join points as an unwoven one.
 */
export const ORIGINAL: unique symbol = Symbol.for("nestjs-aspect:original");

/** Container facts of a class; supplied by the weaver. */
export interface ClassRefFacts {
  beans?: readonly BeanRef[];
  reachesModule?: (root: Class, imported: Class) => boolean;
}

/** Describes a class. Without facts, the class is outside a container. */
export function createClassRef(
  type: Class,
  facts: ClassRefFacts = {},
): ClassRef {
  const reachesModule = facts.reachesModule ?? (() => false);
  return {
    type,
    beans: facts.beans ?? [],
    reachesModule: (root, imported) => reachesModule(root, imported),
  };
}

function unwrap(fn: Fn): Fn {
  let current = fn;
  while (Object.hasOwn(current, ORIGINAL)) {
    current = (current as unknown as Record<symbol, Fn>)[ORIGINAL];
  }
  return current;
}

function memberFunction(
  prototype: object,
  name: string | symbol,
  kind: JoinPointKind,
): Fn | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
  if (!descriptor) {
    return undefined;
  }
  const candidate =
    kind === "method"
      ? descriptor.value
      : kind === "getter"
        ? descriptor.get
        : descriptor.set;
  return typeof candidate === "function" ? unwrap(candidate) : undefined;
}

function isAsyncMember(
  original: Fn,
  declaringType: Class,
  name: string | symbol,
  kind: JoinPointKind,
): boolean {
  if (kind !== "method") {
    return false;
  }
  if (Object.prototype.toString.call(original) === "[object AsyncFunction]") {
    return true;
  }
  return (
    Reflect.getMetadata("design:returntype", declaringType.prototype, name) ===
    Promise
  );
}

/**
 * Describes the member `name` of `classRef.type`, looked up along the
 * prototype chain. The declaring type is the class furthest up the chain
 * whose prototype defines the same function, so an inherited member that a
 * dispatcher stub shadows on the concrete prototype keeps its declaring type.
 *
 * Throws `AopConfigurationError` when the class has no such member of that
 * kind.
 */
export function createMethodRef(
  classRef: ClassRef,
  name: string | symbol,
  kind: JoinPointKind = "method",
): MethodRef {
  let original: Fn | undefined;
  let declaringType: Class = classRef.type;
  for (
    let prototype: object | null = classRef.type.prototype;
    prototype && prototype !== Object.prototype;
    prototype = Object.getPrototypeOf(prototype)
  ) {
    const found = memberFunction(prototype, name, kind);
    if (!original) {
      if (
        !found &&
        Object.getOwnPropertyDescriptor(prototype, name) !== undefined
      ) {
        // A member of another kind shadows everything above it.
        break;
      }
      original = found;
    } else if (found !== original) {
      break;
    }
    if (original) {
      declaringType = prototype.constructor as Class;
    }
  }
  if (!original) {
    throw new AopConfigurationError(
      `${classRef.type.name} has no ${kind} named ${String(name)}`,
    );
  }
  return {
    declaringType,
    targetType: classRef.type,
    classRef,
    name,
    kind,
    original,
    isAsync: isAsyncMember(original, declaringType, name, kind),
  };
}
