// The interceptor chain of one member and its traversal.

import { AspectConfigurationError } from "./errors";
import { createJoinPoint } from "./join-point";
import type {
  AdvisorDescriptor,
  ChainLink,
  AnyShape,
  ChainOptions,
  InterceptorChain,
  JoinPoint,
  MethodInvocation,
  MethodRef,
  RuntimeMethodMatcher,
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
  method: MethodRef,
  advisors: readonly AdvisorDescriptor[],
  options: ChainOptions,
): InterceptorChain {
  const context = { returnValues: options.returnValues };
  const links = advisors.map((advisor): ChainLink => {
    const interceptor = options.adviceAdapters.toInterceptor(
      advisor.advice,
      context,
    );
    const matcher = advisor.pointcut.methodMatcher;
    if (!matcher.isRuntime) {
      return { interceptor, advisor };
    }
    if (typeof matcher.matchesRuntime !== "function") {
      throw new AspectConfigurationError(
        `The method matcher of an advisor of ${advisor.source.type.name} has isRuntime but no matchesRuntime()`,
      );
    }
    return {
      interceptor,
      runtimeMatcher: matcher as RuntimeMethodMatcher,
      advisor,
    };
  });
  return { method, links };
}

/**
 * One traversal of an interceptor chain.
 *
 * `proceed()` takes the next link; a link whose `runtimeMatcher` rejects
 * `(method, args)` is skipped. Past the last link it calls
 * `chain.method.original` with `target` as `this` and `args`.
 *
 * `args` is a frozen copy of the given array, shared with the clones that do
 * not replace it: advice cannot change the arguments of the join point, of
 * other advice or of a later `proceed()` except through `proceedWith`.
 */
export class Invocation implements MethodInvocation {
  readonly args: readonly unknown[];

  private cachedJoinPoint: JoinPoint<AnyShape> | undefined;

  constructor(
    readonly chain: InterceptorChain,
    readonly target: object,
    args: readonly unknown[],
    /** Index of the next link. */
    protected index = 0,
  ) {
    this.args = Object.isFrozen(args) ? args : Object.freeze([...args]);
  }

  get method(): MethodRef {
    return this.chain.method;
  }

  /** Created on first access; one join point per invocation object. */
  get joinPoint(): JoinPoint<AnyShape> {
    this.cachedJoinPoint ??= createJoinPoint(this);
    return this.cachedJoinPoint;
  }

  proceed(): unknown {
    const { links, method } = this.chain;
    while (this.index < links.length) {
      const link = links[this.index++];
      if (
        link.runtimeMatcher &&
        !link.runtimeMatcher.matchesRuntime(method, this.args)
      ) {
        continue;
      }
      return link.interceptor.invoke(this);
    }
    return method.original.apply(this.target, this.args as unknown[]);
  }

  cloneFromHere(args: readonly unknown[] = this.args): Invocation {
    return new Invocation(this.chain, this.target, args, this.index);
  }
}

/**
 * Entry point of a dispatcher stub: runs `chain` for one call. Equivalent to
 * `new Invocation(chain, target, args).proceed()`.
 */
export function invoke(
  chain: InterceptorChain,
  target: object,
  args: readonly unknown[],
): unknown {
  return new Invocation(chain, target, args).proceed();
}
