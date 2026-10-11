// Slice B. Exported signatures are frozen; the bodies are the slice's work.

import type {
  AdvisorDescriptor,
  AnyShape,
  ChainOptions,
  InterceptorChain,
  JoinPoint,
  MethodInvocation,
  MethodRef,
} from "./types";

/**
 * Turns the advisors of one member into its interceptor chain.
 *
 * `advisors` are the advisors whose pointcut matched `method` statically
 * (`matchesStatically`), already ordered by `sortAdvisors`; the chain keeps
 * their order. Each advice is converted through `options.adviceAdapters`. A
 * link gets `runtimeMatcher` when the advisor's method matcher has
 * `isRuntime`.
 */
export function buildChain(
  _method: MethodRef,
  _advisors: readonly AdvisorDescriptor[],
  _options: ChainOptions,
): InterceptorChain {
  throw new Error("not implemented");
}

/**
 * One traversal of an interceptor chain.
 *
 * `proceed()` takes the next link; a link whose `runtimeMatcher` rejects
 * `(method, args)` is skipped. Past the last link it calls
 * `chain.method.original` with `target` as `this` and `args`.
 */
export class Invocation implements MethodInvocation {
  constructor(
    readonly chain: InterceptorChain,
    readonly target: object,
    readonly args: readonly unknown[],
    /** Index of the next link. */
    protected index = 0,
  ) {}

  get method(): MethodRef {
    return this.chain.method;
  }

  /** Created on first access; one join point per invocation object. */
  get joinPoint(): JoinPoint<AnyShape> {
    throw new Error("not implemented");
  }

  proceed(): unknown {
    throw new Error("not implemented");
  }

  cloneFromHere(_args: readonly unknown[] = this.args): Invocation {
    throw new Error("not implemented");
  }
}

/**
 * Entry point of a dispatcher stub: runs `chain` for one call. Equivalent to
 * `new Invocation(chain, target, args).proceed()`.
 */
export function invoke(
  _chain: InterceptorChain,
  _target: object,
  _args: readonly unknown[],
): unknown {
  throw new Error("not implemented");
}
