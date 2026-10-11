import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { createAnnotation } from "./annotation";
import { createClassRef, createMethodRef } from "./method-ref";
import {
  createPointcut,
  guaranteedAnnotations,
  isDefaultJoinPoint,
  matchesStatically,
} from "./pointcut";
import { P } from "./pointcut-designators";
import type { Class, JoinPointKind, MethodRef, PointcutLike } from "./types";

const Audited = createAnnotation<"Audited">("Audited");
const Cached = createAnnotation<"Cached">("Cached");
const Traced = createAnnotation<"Traced">("Traced");

class Account {
  constructor(readonly id: string) {}
}

@Audited()
class AccountService {
  @Cached()
  find(_id: string): Account | undefined {
    return undefined;
  }

  transfer(_from: Account, _amount: number): void {}

  close(_account: Account): void {}

  onModuleInit(): void {}

  onApplicationBootstrap(): void {}

  onModuleDestroy(): void {}

  beforeApplicationShutdown(): void {}

  onApplicationShutdown(): void {}

  get total(): number {
    return 0;
  }

  set total(_value: number) {}
}

class ReportService {
  find(_id: string): string {
    return "";
  }

  transfer(_from: Account, _amount: number): void {}
}

const LIFECYCLE_HOOKS = [
  "onModuleInit",
  "onApplicationBootstrap",
  "onModuleDestroy",
  "beforeApplicationShutdown",
  "onApplicationShutdown",
] as const;

function ref(
  type: Class,
  name: string | symbol,
  kind: JoinPointKind = "method",
): MethodRef {
  return createMethodRef(createClassRef(type), name, kind);
}

/** The complete decision for one call: the static part, then the runtime part. */
function matchesCall(
  pointcut: PointcutLike,
  method: MethodRef,
  args: readonly unknown[],
): boolean {
  if (!matchesStatically(pointcut, method)) {
    return false;
  }
  const matcher = pointcut.methodMatcher;
  return !matcher.isRuntime || matcher.matchesRuntime?.(method, args) === true;
}

const account = new Account("a");
const find = ref(AccountService, "find");
const transfer = ref(AccountService, "transfer");
const close = ref(AccountService, "close");
const reportFind = ref(ReportService, "find");
const reportTransfer = ref(ReportService, "transfer");

describe("and", () => {
  it("matches where both operands match", () => {
    const pointcut = P.within(AccountService).and(P.name("find"));

    expect(matchesStatically(pointcut, find)).toBe(true);
    expect(matchesStatically(pointcut, transfer)).toBe(false);
    expect(matchesStatically(pointcut, reportFind)).toBe(false);
  });

  it("narrows the class filter to classes both operands accept", () => {
    const pointcut = P.target(AccountService).and(P.target(ReportService));

    expect(pointcut.classFilter.matches(createClassRef(AccountService))).toBe(
      false,
    );
  });

  it("decides the static part at weaving time and the arguments on each call", () => {
    const pointcut = P.within(AccountService).and(P.args(Account, P.REST));

    expect(matchesStatically(pointcut, transfer)).toBe(true);
    expect(matchesStatically(pointcut, reportTransfer)).toBe(false);
    expect(matchesCall(pointcut, transfer, [account, 10])).toBe(true);
    expect(matchesCall(pointcut, transfer, ["a", 10])).toBe(false);
    expect(matchesCall(pointcut, reportTransfer, [account, 10])).toBe(false);
  });

  it("requires every runtime operand to accept the arguments", () => {
    const pointcut = P.args(Account, P.REST).and(P.args(P.ANY, Number));

    expect(matchesCall(pointcut, transfer, [account, 10])).toBe(true);
    expect(matchesCall(pointcut, transfer, [account, "10"])).toBe(false);
    expect(matchesCall(pointcut, transfer, [account])).toBe(false);
  });
});

describe("or", () => {
  it("matches where either operand matches", () => {
    const pointcut = P.within(ReportService).or(P.name("close"));

    expect(matchesStatically(pointcut, reportFind)).toBe(true);
    expect(matchesStatically(pointcut, close)).toBe(true);
    expect(matchesStatically(pointcut, find)).toBe(false);
  });

  it("evaluates each side's class filter with its own method matcher", () => {
    // P.target decides in the class filter alone; its method matcher
    // accepts every member.
    const pointcut = P.target(AccountService)
      .and(P.name("find"))
      .or(P.target(ReportService).and(P.name("transfer")));

    expect(matchesStatically(pointcut, find)).toBe(true);
    expect(matchesStatically(pointcut, reportTransfer)).toBe(true);
    expect(matchesStatically(pointcut, transfer)).toBe(false);
    expect(matchesStatically(pointcut, reportFind)).toBe(false);
  });

  it("matches a call through the static side regardless of the arguments", () => {
    const pointcut = P.name("find").or(
      P.within(AccountService).and(P.args(Account, P.REST)),
    );

    expect(matchesCall(pointcut, find, ["id"])).toBe(true);
    expect(matchesCall(pointcut, transfer, [account, 1])).toBe(true);
    expect(matchesCall(pointcut, transfer, ["a", 1])).toBe(false);
  });

  it("does not let the runtime side match a member its static part rejects", () => {
    const pointcut = P.name("find").or(
      P.within(AccountService).and(P.args(Account, P.REST)),
    );

    expect(matchesStatically(pointcut, reportTransfer)).toBe(false);
    expect(matchesCall(pointcut, reportFind, [account])).toBe(true);
    expect(
      pointcut.methodMatcher.matchesRuntime?.(reportTransfer, [account]),
    ).toBe(false);
  });
});

describe("not", () => {
  it("matches where a static operand does not match", () => {
    const pointcut = P.name("find").not();

    expect(pointcut.methodMatcher.isRuntime).toBe(false);
    expect(matchesStatically(pointcut, find)).toBe(false);
    expect(matchesStatically(pointcut, transfer)).toBe(true);
  });

  it("matches classes the operand's class filter rejects", () => {
    const pointcut = P.within(AccountService).not();

    expect(matchesStatically(pointcut, reportFind)).toBe(true);
    expect(matchesStatically(pointcut, find)).toBe(false);
  });

  it("restores the operand when applied twice", () => {
    const pointcut = P.within(AccountService).and(P.name("find")).not().not();

    expect(matchesStatically(pointcut, find)).toBe(true);
    expect(matchesStatically(pointcut, transfer)).toBe(false);
    expect(matchesStatically(pointcut, reportFind)).toBe(false);
  });

  it("negates a runtime operand on each call", () => {
    const pointcut = P.args(Account, P.REST).not();

    expect(pointcut.methodMatcher.isRuntime).toBe(true);
    expect(matchesStatically(pointcut, transfer)).toBe(true);
    expect(matchesCall(pointcut, transfer, [account, 1])).toBe(false);
    expect(matchesCall(pointcut, transfer, ["a", 1])).toBe(true);
  });

  it("negates the complete decision of a mixed operand", () => {
    const pointcut = P.within(AccountService)
      .and(P.args(Account, P.REST))
      .not();

    // Outside AccountService the operand never matches, whatever the arguments.
    expect(matchesCall(pointcut, reportTransfer, [account, 1])).toBe(true);
    expect(matchesCall(pointcut, transfer, [account, 1])).toBe(false);
    expect(matchesCall(pointcut, transfer, ["a", 1])).toBe(true);
  });

  it("scopes a negated runtime operand with a static conjunction", () => {
    const pointcut = P.within(AccountService).and(P.args(Account).not());

    expect(matchesStatically(pointcut, reportTransfer)).toBe(false);
    expect(matchesCall(pointcut, close, [account])).toBe(false);
    expect(matchesCall(pointcut, close, ["a"])).toBe(true);
  });
});

describe("P.all and P.any", () => {
  it("all is the conjunction of its operands", () => {
    const pointcut = P.all(
      P.within(AccountService),
      P.name("*"),
      P.args(Account, P.REST),
    );

    expect(pointcut.methodMatcher.isRuntime).toBe(true);
    expect(matchesCall(pointcut, transfer, [account, 1])).toBe(true);
    expect(matchesCall(pointcut, transfer, [1])).toBe(false);
    expect(matchesStatically(pointcut, reportTransfer)).toBe(false);
  });

  it("any is the disjunction of its operands", () => {
    const pointcut = P.any(
      P.method(AccountService, "find"),
      P.method(AccountService, "close"),
      P.within(ReportService),
    );

    expect(pointcut.methodMatcher.isRuntime).toBe(false);
    expect(matchesStatically(pointcut, find)).toBe(true);
    expect(matchesStatically(pointcut, close)).toBe(true);
    expect(matchesStatically(pointcut, reportFind)).toBe(true);
    expect(matchesStatically(pointcut, transfer)).toBe(false);
  });

  it("all without operands matches every default join point", () => {
    expect(matchesStatically(P.all(), find)).toBe(true);
    expect(matchesStatically(P.all(), reportTransfer)).toBe(true);
    expect(P.all().methodMatcher.isRuntime).toBe(false);
  });

  it("any without operands matches nothing", () => {
    expect(matchesStatically(P.any(), find)).toBe(false);
    expect(matchesStatically(P.any().or(P.name("find")), find)).toBe(true);
  });
});

describe("join points that need an explicit designator", () => {
  const broad = [
    P.all(),
    P.within(AccountService),
    P.target(AccountService),
    P.name("on*"),
    P.name(/Application|Module/),
    P.kind("method"),
    P.withinAnnotated(Audited),
    P.targetAnnotated(Audited),
    P.name("find").not(),
    P.matching({ methodMatcher: { isRuntime: false, matches: () => true } }),
  ];

  it("treats ordinary methods as default join points", () => {
    expect(isDefaultJoinPoint(find)).toBe(true);
    expect(isDefaultJoinPoint(ref(AccountService, "onModuleInit"))).toBe(false);
    expect(isDefaultJoinPoint(ref(AccountService, "total", "getter"))).toBe(
      false,
    );
  });

  it.each(LIFECYCLE_HOOKS)("leaves %s out of broad pointcuts", (hook) => {
    const method = ref(AccountService, hook);

    for (const pointcut of broad) {
      expect(matchesStatically(pointcut, method)).toBe(false);
    }
  });

  it.each(LIFECYCLE_HOOKS)("selects %s through P.method", (hook) => {
    const pointcut = P.method(AccountService, hook);

    expect(matchesStatically(pointcut, ref(AccountService, hook))).toBe(true);
    expect(matchesStatically(pointcut, find)).toBe(false);
  });

  it("keeps the opt-in through and() when both sides match", () => {
    const hook = ref(AccountService, "onModuleInit");
    const explicit = P.method(AccountService, "onModuleInit");

    expect(
      matchesStatically(explicit.and(P.within(AccountService)), hook),
    ).toBe(true);
    expect(
      matchesStatically(P.targetAnnotated(Audited).and(explicit), hook),
    ).toBe(true);
    expect(matchesStatically(explicit.and(P.within(ReportService)), hook)).toBe(
      false,
    );
  });

  it("keeps the opt-in through or() only for the side that selects the member", () => {
    const pointcut = P.method(AccountService, "onModuleInit").or(
      P.within(AccountService),
    );

    expect(
      matchesStatically(pointcut, ref(AccountService, "onModuleInit")),
    ).toBe(true);
    expect(
      matchesStatically(pointcut, ref(AccountService, "onModuleDestroy")),
    ).toBe(false);
    expect(matchesStatically(pointcut, find)).toBe(true);
  });

  it("does not let not() include a lifecycle hook or an accessor", () => {
    const hook = ref(AccountService, "onModuleInit");
    const getter = ref(AccountService, "total", "getter");

    expect(
      matchesStatically(
        P.method(AccountService, "onModuleDestroy").not(),
        hook,
      ),
    ).toBe(false);
    expect(
      matchesStatically(
        P.method(AccountService, "onModuleInit").not().not(),
        hook,
      ),
    ).toBe(false);
    expect(matchesStatically(P.kind("setter").not(), getter)).toBe(false);
    expect(matchesStatically(P.kind("method").not(), getter)).toBe(false);
  });

  it("narrows an accessor opt-in with a negation", () => {
    const pointcut = P.kind("getter").and(P.within(ReportService).not());

    expect(
      matchesStatically(pointcut, ref(AccountService, "total", "getter")),
    ).toBe(true);
    expect(
      matchesStatically(pointcut, ref(AccountService, "total", "setter")),
    ).toBe(false);
  });

  it("never matches the constructor", () => {
    const constructorRef: MethodRef = {
      ...find,
      name: "constructor",
      original: AccountService as unknown as MethodRef["original"],
    };
    const explicit = P.method(
      AccountService,
      "constructor" as unknown as "find",
    );

    expect(matchesStatically(P.all(), constructorRef)).toBe(false);
    expect(matchesStatically(P.name("constructor"), constructorRef)).toBe(
      false,
    );
    expect(matchesStatically(explicit, constructorRef)).toBe(false);
  });

  it("applies the exclusion to a hand-written pointcut, with its own opt-in", () => {
    const hook = ref(AccountService, "onModuleInit");
    const everything: PointcutLike = {
      classFilter: { matches: () => true },
      methodMatcher: { isRuntime: false, matches: () => true },
    };

    expect(matchesStatically(everything, find)).toBe(true);
    expect(matchesStatically(everything, hook)).toBe(false);
    expect(
      matchesStatically(
        { ...everything, includesExplicitly: (method) => method === hook },
        hook,
      ),
    ).toBe(true);
  });

  it("consults a custom opt-in only for members the pointcut matches", () => {
    const pointcut = createPointcut({
      classFilter: { matches: (classRef) => classRef.type === ReportService },
      includesExplicitly: () => true,
    });

    expect(
      pointcut.includesExplicitly(ref(AccountService, "onModuleInit")),
    ).toBe(false);
  });
});

describe("guaranteed annotations", () => {
  const names = (pointcut: PointcutLike) =>
    [...guaranteedAnnotations(pointcut)].sort();

  it("are empty for designators that prove no annotation", () => {
    expect(names(P.within(AccountService))).toEqual([]);
    expect(names(P.all())).toEqual([]);
    expect(
      names({
        classFilter: { matches: () => true },
        methodMatcher: { isRuntime: false, matches: () => true },
      }),
    ).toEqual([]);
  });

  it("are the union for and()", () => {
    expect(names(P.annotated(Cached).and(P.withinAnnotated(Audited)))).toEqual([
      "Audited",
      "Cached",
    ]);
    expect(names(P.annotated(Cached).and(P.name("find")))).toEqual(["Cached"]);
    expect(
      names(P.all(P.annotated(Cached), P.annotated(Traced), P.name("*"))),
    ).toEqual(["Cached", "Traced"]);
  });

  it("are the intersection for or()", () => {
    expect(names(P.annotated(Audited).or(P.withinAnnotated(Audited)))).toEqual([
      "Audited",
    ]);
    expect(names(P.annotated(Audited).or(P.annotated(Cached)))).toEqual([]);
    expect(names(P.annotated(Audited).or(P.name("find")))).toEqual([]);
    expect(
      names(
        P.annotated(Audited)
          .and(P.annotated(Cached))
          .or(P.annotated(Cached).and(P.annotated(Traced))),
      ),
    ).toEqual(["Cached"]);
    expect(
      names(P.any(P.annotated(Audited), P.targetAnnotated(Audited))),
    ).toEqual(["Audited"]);
  });

  it("are empty for not()", () => {
    expect(names(P.annotated(Audited).not())).toEqual([]);
    expect(names(P.annotated(Audited).not().not())).toEqual([]);
    expect(names(P.annotated(Cached).and(P.annotated(Audited).not()))).toEqual([
      "Cached",
    ]);
  });

  it("hold on every join point the pointcut matches", () => {
    const pointcut = P.annotated(Cached).and(P.withinAnnotated(Audited));

    expect(matchesStatically(pointcut, find)).toBe(true);
    expect(matchesStatically(pointcut, transfer)).toBe(false);
  });
});
