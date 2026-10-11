// Test fixture: hand-written pointcuts and a minimal weaver that installs
// interceptor chains on one object, without a Nest container.

import {
  createAdviceAdapterRegistry,
  createReturnValueAdapterRegistry,
} from "./advice";
import {
  compileAspect,
  describeAdvisor,
  sortAdvisors,
} from "./aspect-compiler";
import { buildChain, invoke } from "./invocation";
import { createClassRef, createMethodRef } from "./method-ref";
import { matchesStatically } from "./pointcut";
import type {
  AdviceAdapter,
  AnyShape,
  AspectInstanceResolver,
  ChainOptions,
  Class,
  MethodRef,
  Pointcut,
  PointcutAdvisor,
  PointcutLike,
  ReturnValueAdapter,
  Shape,
} from "./types";

/**
 * A pointcut written against the low-level interface. With `matchesRuntime`
 * its method matcher is a runtime matcher.
 */
export function matching<S extends Shape = AnyShape>(
  matches: (method: MethodRef) => boolean = () => true,
  matchesRuntime?: (method: MethodRef, args: readonly unknown[]) => boolean,
): Pointcut<S> {
  const pointcut: PointcutLike = {
    classFilter: { matches: () => true },
    methodMatcher: matchesRuntime
      ? { matches, isRuntime: true, matchesRuntime }
      : { matches, isRuntime: false },
  };
  return pointcut as Pointcut<S>;
}

/** A pointcut that matches the members with one of the given names. */
export function named<S extends Shape = AnyShape>(
  ...names: string[]
): Pointcut<S> {
  return matching<S>((method) => names.includes(String(method.name)));
}

export interface WeaveOptions {
  advisors?: readonly PointcutAdvisor[];
  adviceAdapters?: readonly AdviceAdapter[];
  returnValueAdapters?: readonly ReturnValueAdapter<any>[];
  resolveAspect?: AspectInstanceResolver;
}

function methodNames(type: Class): Set<string> {
  const names = new Set<string>();
  for (
    let prototype: object | null = type.prototype;
    prototype && prototype !== Object.prototype;
    prototype = Object.getPrototypeOf(prototype)
  ) {
    for (const [name, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(prototype),
    )) {
      if (name !== "constructor" && typeof descriptor.value === "function") {
        names.add(name);
      }
    }
  }
  return names;
}

/**
 * Replaces the methods of `target` that the aspects and advisors match with
 * functions that run their interceptor chain. Aspects register in array
 * order, advisors after them.
 */
export function weave<T extends object>(
  target: T,
  aspects: readonly object[] = [],
  options: WeaveOptions = {},
): T {
  const instances = new Map<Class, object>(
    aspects.map((aspect) => [aspect.constructor as Class, aspect]),
  );
  const resolveAspect: AspectInstanceResolver =
    options.resolveAspect ?? ((type) => instances.get(type));
  const descriptors = [
    ...aspects.flatMap((aspect, registration) =>
      compileAspect(aspect.constructor as Class, {
        resolveAspect,
        registration,
      }),
    ),
    ...(options.advisors ?? []).map((advisor, index) =>
      describeAdvisor(
        advisor,
        advisor.constructor as Class,
        aspects.length + index,
      ),
    ),
  ];
  const chainOptions: ChainOptions = {
    adviceAdapters: createAdviceAdapterRegistry(options.adviceAdapters),
    returnValues: createReturnValueAdapterRegistry(options.returnValueAdapters),
  };
  const classRef = createClassRef(target.constructor as Class);
  for (const name of methodNames(classRef.type)) {
    const method = createMethodRef(classRef, name);
    const matched = sortAdvisors(
      descriptors.filter(({ pointcut }) => matchesStatically(pointcut, method)),
    );
    if (matched.length === 0) {
      continue;
    }
    const chain = buildChain(method, matched, chainOptions);
    Object.defineProperty(target, name, {
      configurable: true,
      writable: true,
      value(this: object, ...args: unknown[]) {
        return invoke(chain, this, args);
      },
    });
  }
  return target;
}

/** Settles a call into its value or its error, for sync and async members. */
export async function outcome(
  call: () => unknown,
): Promise<{ value: unknown } | { error: unknown }> {
  try {
    return { value: await call() };
  } catch (error) {
    return { error };
  }
}
