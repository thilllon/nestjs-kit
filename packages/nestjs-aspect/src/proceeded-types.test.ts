// Type fixture of the around advice result.
// `pnpm typecheck` checks it; every `@ts-expect-error` marks advice whose
// result `@Around` rejects, and every unmarked advice compiles. The test
// evaluates the fixture, which applies every advice decorator.

/* oxlint-disable no-unused-vars -- the fixture declares classes and advice only to be type-checked */

import { BehaviorSubject, defer, map, type Observable, of, retry } from "rxjs";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  Around,
  type AroundResult,
  Aspect,
  type AnyShape,
  createAnnotation,
  Pointcut as P,
  type Pointcut,
  type Proceeded,
  type ProceededOf,
  type ProceedingJoinPoint,
  type ProceedingJoinPointOf,
  type Shape,
} from "./index";

class User {
  constructor(readonly name: string) {}
}

class Admin extends User {
  readonly admin = true as const;
}

declare class CancelablePromise<T> extends Promise<T> {
  cancel(): void;
}

declare function cancelable<T>(promise: Promise<T>): CancelablePromise<T>;
declare function tx<T>(work: () => Promise<T>): Promise<T>;
declare function sleep(milliseconds: number): Promise<void>;
declare const cache: Map<string, unknown>;

class Base {
  a(): User {
    return new User("base");
  }

  n(): number {
    return 1;
  }
}

class Narrow extends Base {
  override a(): Admin {
    return new Admin("narrow");
  }
}

class Users {
  greet(name: string): string {
    return `hello ${name}`;
  }

  async load(id: number): Promise<User> {
    return new User(String(id));
  }

  async find(id: number): Promise<User | null> {
    return id > 0 ? new User(String(id)) : null;
  }

  lazy(id: number): PromiseLike<User> {
    return Promise.resolve(new User(String(id)));
  }

  pending(id: number): CancelablePromise<User> {
    return cancelable(this.load(id));
  }

  names(): Observable<string> {
    return of("a", "b");
  }

  current(): BehaviorSubject<User> {
    return new BehaviorSubject(new User("current"));
  }

  reset(): void {}

  async flush(): Promise<void> {}

  status(): { proceeded: boolean; value: string } {
    return { proceeded: true, value: "ok" };
  }
}

/** Declares the annotations, pointcuts and aspects of the fixture. */
function declareFixture() {
  const Timed = createAnnotation("Timed", { async: true });
  const Logged = createAnnotation("Logged");
  const Loads = createAnnotation<"Loads", void, () => Promise<User>>("Loads");
  const Retryable = createAnnotation<"Retryable", { attempts: number }>(
    "Retryable",
    { async: true },
  );

  class Admins {
    @Loads()
    async current(): Promise<Admin> {
      return new Admin("root");
    }
  }

  const baseA = P.method(Base, "a");
  const baseN = P.method(Base, "n");
  const aOrN = baseA.or(baseN);
  const greet = P.method(Users, "greet");
  const load = P.method(Users, "load");
  const greetOrLoad = greet.or(load);
  const find = P.method(Users, "find");
  const lazy = P.method(Users, "lazy");
  const pending = P.method(Users, "pending");
  const names = P.method(Users, "names");
  const current = P.method(Users, "current");
  const reset = P.method(Users, "reset");
  const flush = P.method(Users, "flush");
  const status = P.method(Users, "status");

  let stored: Proceeded<User> | undefined;

  @Aspect()
  class Forgeries {
    // @ts-expect-error a wrapped result is no value the join point produced
    @Around(Timed)
    async wrap(joinPoint: ProceedingJoinPointOf<typeof Timed>) {
      return { data: await joinPoint.proceed() };
    }

    // @ts-expect-error a spread copy drops the brand
    @Around(Timed)
    async spread(joinPoint: ProceedingJoinPointOf<typeof Timed>) {
      const result = await joinPoint.proceed();
      return { ...(result as object), extra: 1 };
    }

    // @ts-expect-error a literal is no value the join point produced
    @Around(Timed)
    async literal(_joinPoint: ProceedingJoinPointOf<typeof Timed>) {
      return 5;
    }

    // @ts-expect-error null is no value the join point produced for an unknown result
    @Around(Timed)
    async nothing(_joinPoint: ProceedingJoinPointOf<typeof Timed>) {
      return null;
    }

    // @ts-expect-error undefined is no value the join point produced for an unknown result
    @Around(Logged)
    skip(_joinPoint: ProceedingJoinPointOf<typeof Logged>) {
      return undefined;
    }

    // @ts-expect-error a cache hit of type unknown needs replaceResult
    @Around(Timed)
    async cacheHit(joinPoint: ProceedingJoinPointOf<typeof Timed>) {
      const hit: unknown = cache.get(String(joinPoint.args[0]));
      if (hit !== undefined) {
        return hit;
      }
      return joinPoint.proceed();
    }

    // @ts-expect-error synchronous advice on an asynchronous join point returns a promise
    @Around(Timed)
    syncReplacement(joinPoint: ProceedingJoinPointOf<typeof Timed>) {
      return joinPoint.replaceResult("cached");
    }

    // @ts-expect-error a value derived from an any result is no value the join point produced
    @Around(Logged)
    derived(joinPoint: ProceedingJoinPointOf<typeof Logged>) {
      return { name: joinPoint.proceed().name };
    }

    // @ts-expect-error a User where the contract method returns an Admin
    @Around(Loads)
    async contract(_joinPoint: ProceedingJoinPointOf<typeof Loads>) {
      return new User("guest");
    }

    // @ts-expect-error a User where an override returns an Admin
    @Around(baseA)
    override(_joinPoint: ProceedingJoinPointOf<typeof baseA>) {
      return new User("guest");
    }

    // @ts-expect-error a number is no value either method of or() produced
    @Around(aOrN)
    union(_joinPoint: ProceedingJoinPointOf<typeof aOrN>) {
      return 1;
    }

    // @ts-expect-error a computed number is no value the join point produced
    @Around(baseN)
    double(joinPoint: ProceedingJoinPointOf<typeof baseN>) {
      return joinPoint.proceed() * 2;
    }

    // @ts-expect-error a result of a(): User is no result of n(): number
    @Around(baseN)
    crossShape(_joinPoint: ProceedingJoinPointOf<typeof baseN>) {
      return stored!;
    }

    // @ts-expect-error a constructed User is no value the join point produced
    @Around(find)
    async nullable(_joinPoint: ProceedingJoinPointOf<typeof find>) {
      return new User("guest");
    }

    // @ts-expect-error a mapped value is no value the join point produced
    @Around(names)
    mapped(joinPoint: ProceedingJoinPointOf<typeof names>) {
      return joinPoint.proceed().pipe(map((name) => name.toUpperCase()));
    }

    // @ts-expect-error a constructed Observable is no value the join point produced
    @Around(names)
    constructed(_joinPoint: ProceedingJoinPointOf<typeof names>) {
      return of("x");
    }

    // @ts-expect-error proceed() of a CancelablePromise is a plain Promise
    @Around(pending)
    plainPromise(joinPoint: ProceedingJoinPointOf<typeof pending>) {
      return joinPoint.proceed();
    }

    // @ts-expect-error proceed() of a BehaviorSubject is a plain Observable
    @Around(current)
    plainObservable(joinPoint: ProceedingJoinPointOf<typeof current>) {
      return joinPoint.proceed();
    }

    // @ts-expect-error replaceResult on or() of a synchronous and an asynchronous method fits neither result
    @Around(greetOrLoad)
    unionReplacement(joinPoint: ProceedingJoinPointOf<typeof greetOrLoad>) {
      return joinPoint.replaceResult("cached");
    }

    // @ts-expect-error a literal with the result's members is no value the join point produced
    @Around(status)
    statusLiteral(joinPoint: ProceedingJoinPointOf<typeof status>) {
      void joinPoint;
      return { proceeded: true, value: "forged" };
    }
  }

  @Aspect()
  class Accepted {
    @Around(status)
    readsResultMembers(joinPoint: ProceedingJoinPointOf<typeof status>) {
      const result = joinPoint.proceed();
      const value: string = result.value;
      const proceeded: boolean = result.proceeded;
      void value;
      void proceeded;
      return result;
    }

    @Around(Timed)
    async time(joinPoint: ProceedingJoinPointOf<typeof Timed>) {
      const started = performance.now();
      try {
        return await joinPoint.proceed();
      } finally {
        console.log(performance.now() - started);
      }
    }

    @Around(Timed)
    async timeAnnotated(
      joinPoint: ProceedingJoinPointOf<typeof Timed>,
    ): ProceededOf<typeof Timed> {
      return await joinPoint.proceed();
    }

    @Around(Retryable)
    async retry(joinPoint: ProceedingJoinPointOf<typeof Retryable>) {
      const { attempts } = joinPoint.annotation(Retryable);
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await joinPoint.proceed();
        } catch (error) {
          if (attempt >= attempts) {
            throw error;
          }
          await sleep(10);
        }
      }
    }

    @Around(Timed)
    transaction(joinPoint: ProceedingJoinPointOf<typeof Timed>) {
      return tx(async () => joinPoint.proceed());
    }

    @Around(Logged)
    log(joinPoint: ProceedingJoinPointOf<typeof Logged>) {
      const result = joinPoint.proceed();
      console.log(`${joinPoint}`, result.name);
      return result;
    }

    @Around(P.name("find*"))
    unknownResult(joinPoint: ProceedingJoinPointOf<Pointcut<AnyShape>>) {
      const result = joinPoint.proceed();
      // @ts-expect-error the members of an unknown result are not known
      void result.name;
      return result;
    }

    @Around(P.within(User))
    wider(joinPoint: ProceedingJoinPoint<AnyShape>): Proceeded<unknown> {
      return joinPoint.proceed();
    }

    @Around(Loads)
    async contract(joinPoint: ProceedingJoinPointOf<typeof Loads>) {
      const user = await joinPoint.proceed();
      console.log(user.name);
      return user;
    }

    @Around(baseA)
    override(joinPoint: ProceedingJoinPointOf<typeof baseA>): Proceeded<User> {
      stored = joinPoint.proceed();
      return stored;
    }

    @Around(greet)
    sync(joinPoint: ProceedingJoinPointOf<typeof greet>) {
      const result = joinPoint.proceed();
      console.log(result.length);
      return result;
    }

    @Around(greet)
    trimmed(joinPoint: ProceedingJoinPointOf<typeof greet>) {
      const [name] = joinPoint.args;
      return joinPoint.proceedWith(name.trim());
    }

    @Around(greetOrLoad)
    union(joinPoint: ProceedingJoinPointOf<typeof greetOrLoad>) {
      return joinPoint.proceed();
    }

    // replaceResult on or() of two synchronous methods takes either result, unchecked
    @Around(aOrN)
    unionReplacement(joinPoint: ProceedingJoinPointOf<typeof aOrN>) {
      return joinPoint.replaceResult(1);
    }

    // a value derived from an any result is any and is not checked
    @Around(Logged)
    derivedAny(joinPoint: ProceedingJoinPointOf<typeof Logged>) {
      return joinPoint.proceed().data;
    }

    @Around(find)
    async nullable(joinPoint: ProceedingJoinPointOf<typeof find>) {
      const user = await joinPoint.proceed();
      if (user === null) {
        return null;
      }
      console.log(user.name);
      return user;
    }

    @Around(lazy)
    async promiseLike(joinPoint: ProceedingJoinPointOf<typeof lazy>) {
      return await joinPoint.proceed();
    }

    @Around(reset)
    voidSync(joinPoint: ProceedingJoinPointOf<typeof reset>) {
      if (joinPoint.args.length > 0) {
        return;
      }
      joinPoint.proceed();
    }

    @Around(flush)
    async voidAsync(joinPoint: ProceedingJoinPointOf<typeof flush>) {
      if (joinPoint.args.length > 0) {
        return;
      }
      await joinPoint.proceed();
    }

    @Around(names)
    retried(joinPoint: ProceedingJoinPointOf<typeof names>) {
      return joinPoint.proceed().pipe(retry(2));
    }

    @Around(names)
    deferred(joinPoint: ProceedingJoinPointOf<typeof names>) {
      return defer(() => joinPoint.proceed());
    }

    @Around(pending)
    subclassPromise(joinPoint: ProceedingJoinPointOf<typeof pending>) {
      return cancelable(joinPoint.proceed());
    }

    @Around(current)
    subclassObservable(joinPoint: ProceedingJoinPointOf<typeof current>) {
      const subject = new BehaviorSubject(new User("initial"));
      joinPoint.proceed().subscribe(subject);
      return subject;
    }

    @Around(load)
    async memo(joinPoint: ProceedingJoinPointOf<typeof load>) {
      const memo = new Map<number, Proceeded<User>>();
      const [id] = joinPoint.args;
      const hit = memo.get(id);
      if (hit) {
        return hit;
      }
      const user = await joinPoint.proceed();
      memo.set(id, user);
      return user;
    }

    @Around(load)
    genericHelper(joinPoint: ProceedingJoinPointOf<typeof load>) {
      return pass(joinPoint);
    }
  }

  @Aspect()
  class Replacements {
    @Around(Timed)
    async cacheHit(joinPoint: ProceedingJoinPointOf<typeof Timed>) {
      const hit: unknown = cache.get(String(joinPoint.args[0]));
      if (hit !== undefined) {
        return joinPoint.replaceResult(hit);
      }
      return joinPoint.proceed();
    }

    @Around(Timed)
    resolved(joinPoint: ProceedingJoinPointOf<typeof Timed>) {
      return Promise.resolve(joinPoint.replaceResult("cached"));
    }

    @Around(Logged)
    skip(joinPoint: ProceedingJoinPointOf<typeof Logged>) {
      return joinPoint.replaceResult(undefined);
    }

    @Around(load)
    async fallback(joinPoint: ProceedingJoinPointOf<typeof load>) {
      try {
        return await joinPoint.proceed();
      } catch {
        return joinPoint.replaceResult(new User("guest"));
      }
    }

    @Around(load)
    async mistyped(joinPoint: ProceedingJoinPointOf<typeof load>) {
      // @ts-expect-error replaceResult checks the value against the declared result
      return joinPoint.replaceResult({ data: 1 });
    }

    // The declared result of Loads is User; the method returns an Admin.
    @Around(Loads)
    async contract(joinPoint: ProceedingJoinPointOf<typeof Loads>) {
      return joinPoint.replaceResult(new User("guest"));
    }

    @Around(names)
    cachedObservable(joinPoint: ProceedingJoinPointOf<typeof names>) {
      return of(joinPoint.replaceResult("cached"));
    }
  }

  return { Admins, Narrow, Forgeries, Accepted, Replacements };
}

function pass<S extends Shape>(
  joinPoint: ProceedingJoinPoint<S>,
): Proceeded<S["returns"]> {
  return joinPoint.proceed();
}

function passDeferred<S extends Shape>(
  joinPoint: ProceedingJoinPoint<S>,
): AroundResult<S["returns"]> {
  // @ts-expect-error Proceeded<S["returns"]> is not assignable to the deferred AroundResult
  return joinPoint.proceed();
}

describe("around advice result types", () => {
  it("apply every advice decorator of the fixture", () => {
    expect(() => declareFixture()).not.toThrow();
  });

  it("map Promise, PromiseLike and Observable results to their base types", () => {
    expectTypeOf<Proceeded<Promise<User>>>().toEqualTypeOf<
      Promise<Proceeded<User>>
    >();
    expectTypeOf<Proceeded<PromiseLike<User>>>().toEqualTypeOf<
      PromiseLike<Proceeded<User>>
    >();
    expectTypeOf<Proceeded<CancelablePromise<User>>>().toEqualTypeOf<
      Promise<Proceeded<User>>
    >();
    expectTypeOf<Proceeded<BehaviorSubject<User>>>().toEqualTypeOf<
      Observable<Proceeded<User>>
    >();
    expectTypeOf<
      Proceeded<User | null>
    >().toEqualTypeOf<Proceeded<User> | null>();
  });

  it("keep a Promise or Observable subclass in the advice result", () => {
    expectTypeOf<AroundResult<CancelablePromise<User>>>().toEqualTypeOf<
      CancelablePromise<User>
    >();
    expectTypeOf<AroundResult<BehaviorSubject<User>>>().toEqualTypeOf<
      BehaviorSubject<User>
    >();
    expectTypeOf<AroundResult<Promise<void>>>().toEqualTypeOf<Promise<void>>();
  });
});
