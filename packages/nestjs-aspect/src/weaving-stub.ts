// The dispatcher stub that replaces a woven member on a class prototype.

import { AspectConfigurationError } from "./errors";
import { ORIGINAL } from "./method-ref";
import type { Class, Fn, JoinPointKind, MethodRef } from "./types";
import { resolveContext } from "./weaving-context";

/** Descriptor field that holds the function of a join point kind. */
const DESCRIPTOR_FIELD = {
  method: "value",
  getter: "get",
  setter: "set",
} as const;

/** Own property of a dispatcher stub that holds the class it is installed on. */
const OWNER: unique symbol = Symbol.for("nestjs-aspect:stub-owner");

/** Join point kind of each accessor field of a property descriptor. */
const ACCESSOR_KIND = { get: "getter", set: "setter" } as const;

/** True for a dispatcher stub of any copy of the package. */
export function isStub(value: unknown): value is Fn {
  return typeof value === "function" && Object.hasOwn(value, ORIGINAL);
}

function isStubOf(value: unknown, owner: Class): boolean {
  return (
    isStub(value) &&
    (value as unknown as Record<symbol, unknown>)[OWNER] === owner
  );
}

function originalOf(stub: Fn): Fn {
  return (stub as unknown as Record<symbol, Fn>)[ORIGINAL];
}

/** The nearest descriptor of `name` along the prototype chain. */
function findDescriptor(
  prototype: object,
  name: string | symbol,
): PropertyDescriptor | undefined {
  for (
    let current: object | null = prototype;
    current;
    current = Object.getPrototypeOf(current)
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor) {
      return descriptor;
    }
  }
  return undefined;
}

/**
 * A function that runs the interceptor chain of the application `this`
 * belongs to, or `original` for an object no live application advises.
 *
 * It keeps the name and the length of `original` and has `original` as its
 * prototype, so Reflect metadata defined on `original`, such as route and
 * `SetMetadata` metadata, is found on the stub.
 */
function createStub(
  owner: Class,
  name: string | symbol,
  kind: JoinPointKind,
  original: Fn,
): Fn {
  const stub = function (this: unknown, ...args: unknown[]): unknown {
    const context = resolveContext(this, owner);
    return context
      ? context.dispatch(owner, name, kind, this as object, args, original)
      : original.apply(this, args);
  };
  Object.defineProperty(stub, "name", {
    value: original.name,
    configurable: true,
  });
  Object.defineProperty(stub, "length", {
    value: original.length,
    configurable: true,
  });
  Object.setPrototypeOf(stub, original);
  Object.defineProperty(stub, ORIGINAL, { value: original });
  Object.defineProperty(stub, OWNER, { value: owner });
  return stub;
}

/**
 * Installs the stub of `method` as an own property of the prototype of
 * `method.targetType`, unless that prototype already holds the stub of that
 * class. A class has one stub per member and kind, whatever the number of
 * advisors and applications.
 *
 * - An inherited member gets its stub on the concrete class; the stub calls
 *   `method.original`, the inherited function, not a stub of the superclass.
 * - A getter and a setter of one property are replaced independently. An
 *   accessor that is not matched keeps its function, except for the stub of a
 *   superclass: the property becomes an own property of the class, so the
 *   other accessor gets a stub of the class too, which runs the original
 *   function until an application weaves that accessor.
 *
 * Throws `AspectConfigurationError` when the property cannot be redefined.
 */
export function installStub(method: MethodRef): void {
  const { targetType, name, kind, original } = method;
  const prototype: object = targetType.prototype;
  const field = DESCRIPTOR_FIELD[kind];
  const own = Object.getOwnPropertyDescriptor(prototype, name);
  if (own && isStubOf(own[field], targetType)) {
    return;
  }
  const descriptor = { ...(own ?? findDescriptor(prototype, name)) };
  for (const other of ["get", "set"] as const) {
    const inherited: unknown = descriptor[other];
    if (
      other !== field &&
      isStub(inherited) &&
      !isStubOf(inherited, targetType)
    ) {
      descriptor[other] = createStub(
        targetType,
        name,
        ACCESSOR_KIND[other],
        originalOf(inherited),
      );
    }
  }
  try {
    Object.defineProperty(prototype, name, {
      ...descriptor,
      [field]: createStub(targetType, name, kind, original),
    });
  } catch (error) {
    throw new AspectConfigurationError(
      `${targetType.name}.${String(name)} cannot be woven: its prototype does not allow the property to be redefined`,
      { cause: error },
    );
  }
}
