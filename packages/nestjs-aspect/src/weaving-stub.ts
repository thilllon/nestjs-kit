// The dispatcher stub that replaces a woven member on a class prototype.

import { AspectConfigurationError, AspectUsageError } from "./errors";
import { ORIGINAL } from "./method-ref";
import type { Class, Fn, JoinPointKind, MethodRef } from "./types";
import {
  type ContextHandle,
  registerStub,
  requiresClosedAdvice,
  resolveContext,
  type StubRecord,
  stubRecord,
} from "./weaving-registry";

/** Descriptor field that holds the function of a join point kind. */
const DESCRIPTOR_FIELD = {
  method: "value",
  getter: "get",
  setter: "set",
} as const;

/** Join point kind of each accessor field of a property descriptor. */
const ACCESSOR_KIND = { get: "getter", set: "setter" } as const;

/**
 * True for a dispatcher stub of any copy of the package. The registry of the
 * process decides: a function that only carries the `ORIGINAL` property of a
 * stub is none.
 */
export function isStub(value: unknown): value is Fn {
  return stubRecord(value) !== undefined;
}

function isStubOf(value: unknown, owner: Class): boolean {
  return stubRecord(value)?.owner === owner;
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
 * For an object that a closed application created it raises
 * `AspectConfigurationError` when the member requires advice in that
 * application: such a member never runs without its advice.
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
  introduced = false,
): Fn {
  const record: StubRecord = {
    owner,
    original,
    introduced,
    required: new WeakSet(),
  };
  const stub = function (this: unknown, ...args: unknown[]): unknown {
    const context = resolveContext(this, owner);
    if (context) {
      return context.dispatch(
        owner,
        name,
        kind,
        this as object,
        args,
        original,
      );
    }
    if (requiresClosedAdvice(this, record)) {
      throw new AspectConfigurationError(
        `${owner.name}.${String(name)} requires advice, and the application of the instance it was called on is closed`,
      );
    }
    return original.apply(this, args);
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
  registerStub(stub, record);
  return stub;
}

/**
 * Records that the member `method` requires advice in the application of
 * `handle`. The stub of the member is installed.
 */
export function requireAdvice(method: MethodRef, handle: ContextHandle): void {
  const { targetType, name, kind } = method;
  const own = Object.getOwnPropertyDescriptor(targetType.prototype, name);
  const record = stubRecord(own?.[DESCRIPTOR_FIELD[kind]]);
  if (record?.owner === targetType) {
    record.required.add(handle);
  }
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
 * Throws `AspectConfigurationError` when the property cannot be redefined,
 * and when the function on the prototype is not the one `method` describes:
 * it carries the `ORIGINAL` property of a stub without being one, so the
 * member cannot be woven reliably.
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
  const current: unknown = descriptor[field];
  if ((stubRecord(current)?.original ?? current) !== original) {
    throw new AspectConfigurationError(
      `${targetType.name}.${String(name)} cannot be woven: the function on its prototype carries the stub marker of nestjs-aspect without being a stub of it`,
    );
  }
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
        stubRecord(inherited)?.original ?? inherited,
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

/**
 * Installs the stub of a member that an introduction adds to `type` and
 * returns the function the stub runs for an object whose application does
 * not declare the introduction: the member the class already has, or, for a
 * member that only the introduction adds, a function that raises
 * `AspectUsageError`. The prototype is shared by every application, so the
 * member exists for all of them.
 */
export function installIntroductionStub(
  type: Class,
  name: string | symbol,
  kind: JoinPointKind,
): Fn {
  const prototype: object = type.prototype;
  const field = DESCRIPTOR_FIELD[kind];
  const own = Object.getOwnPropertyDescriptor(prototype, name);
  const record = stubRecord(own?.[field]);
  if (record?.owner === type) {
    return record.original;
  }
  const descriptor = own ?? findDescriptor(prototype, name);
  const current: unknown = descriptor?.[field];
  const existing =
    typeof current === "function"
      ? (stubRecord(current)?.original ?? (current as Fn))
      : undefined;
  const original =
    existing ??
    function missing(): never {
      throw new AspectUsageError(
        `${type.name}.${String(name)} is introduced by an aspect, and the application of the instance it was called on is closed or does not declare the introduction`,
      );
    };
  const introduced = existing === undefined || stubRecord(current)?.introduced;
  const stub = createStub(type, name, kind, original, introduced);
  // The property becomes an own property of the class, so the accessor the
  // introduction does not add keeps the function the class has or inherits.
  const accessors: Pick<PropertyDescriptor, "get" | "set"> = {};
  for (const other of ["get", "set"] as const) {
    const inherited: unknown = descriptor?.[other];
    if (other !== field && typeof inherited === "function") {
      accessors[other] =
        isStub(inherited) && !isStubOf(inherited, type)
          ? createStub(
              type,
              name,
              ACCESSOR_KIND[other],
              stubRecord(inherited)?.original ?? inherited,
            )
          : (inherited as Fn);
    }
  }
  try {
    Object.defineProperty(
      prototype,
      name,
      kind === "method"
        ? { value: stub, writable: true, enumerable: false, configurable: true }
        : {
            ...accessors,
            [field]: stub,
            enumerable: false,
            configurable: true,
          },
    );
  } catch (error) {
    throw new AspectConfigurationError(
      `${type.name}.${String(name)} cannot be introduced: its prototype does not allow the property to be defined`,
      { cause: error },
    );
  }
  return original;
}
