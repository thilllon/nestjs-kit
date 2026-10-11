import "reflect-metadata";
import { SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { describe, expect, it } from "vitest";
import { createAnnotation } from "./annotation";
import { AspectConfigurationError } from "./errors";
import {
  type ClassRefFacts,
  createClassRef,
  createMethodRef,
} from "./method-ref";
import { guaranteedAnnotations, matchesStatically } from "./pointcut";
import { P } from "./pointcut-designators";
import type { Class, JoinPointKind, MethodRef, PointcutLike } from "./types";

const Audited = createAnnotation<"Audited">("Audited");
const Cached = createAnnotation<"Cached", number>("Cached");
const Roles = Reflector.createDecorator<string[]>();

class Account {
  constructor(readonly id: string) {}
}

class SavingsAccount extends Account {}

class BaseRepository {
  @Cached(10)
  findAll(): string[] {
    return [];
  }

  findOne(_id: number): string {
    return "";
  }

  save(_value: string): void {}
}

@Audited()
class UserRepository extends BaseRepository {
  override findOne(_id: number): string {
    return "user";
  }

  @Audited()
  @Roles(["admin"])
  @SetMetadata("roles", ["admin"])
  remove(_id: number): void {}

  findByAccount(_account: Account, _limit?: number): string[] {
    return [];
  }

  get size(): number {
    return 0;
  }

  set size(_value: number) {}

  [Symbol.iterator](): Iterator<string> {
    return [][Symbol.iterator]();
  }
}

class OrderRepository extends BaseRepository {
  findOrders(): string[] {
    return [];
  }
}

function ref(
  type: Class,
  name: string | symbol,
  kind: JoinPointKind = "method",
  facts?: ClassRefFacts,
): MethodRef {
  return createMethodRef(createClassRef(type, facts), name, kind);
}

function matches(pointcut: PointcutLike, method: MethodRef): boolean {
  return matchesStatically(pointcut, method);
}

function matchesCall(
  pointcut: PointcutLike,
  method: MethodRef,
  args: readonly unknown[],
): boolean {
  return (
    matchesStatically(pointcut, method) &&
    pointcut.methodMatcher.matchesRuntime?.(method, args) === true
  );
}

describe("P.method", () => {
  const pointcut = P.method(BaseRepository, "findOne");

  it("matches the named method of the type", () => {
    expect(matches(pointcut, ref(BaseRepository, "findOne"))).toBe(true);
    expect(matches(pointcut, ref(BaseRepository, "findAll"))).toBe(false);
  });

  it("matches the method on subclasses, inherited or overridden", () => {
    expect(matches(pointcut, ref(UserRepository, "findOne"))).toBe(true);
    expect(matches(pointcut, ref(OrderRepository, "findOne"))).toBe(true);
  });

  it("does not match the method on a superclass or an unrelated class", () => {
    class Unrelated {
      findOne(): void {}
    }

    expect(
      matches(
        P.method(UserRepository, "findOne"),
        ref(BaseRepository, "findOne"),
      ),
    ).toBe(false);
    expect(matches(pointcut, ref(Unrelated, "findOne"))).toBe(false);
  });

  it("does not match a getter that returns a function", () => {
    class Handlers {
      get handler(): () => void {
        return () => undefined;
      }
    }

    expect(
      matches(
        P.method(Handlers, "handler"),
        ref(Handlers, "handler", "getter"),
      ),
    ).toBe(false);
  });
});

describe("P.within and P.target", () => {
  it("within matches members declared on the class only", () => {
    const pointcut = P.within(UserRepository);

    expect(matches(pointcut, ref(UserRepository, "remove"))).toBe(true);
    expect(matches(pointcut, ref(UserRepository, "findOne"))).toBe(true);
    expect(matches(pointcut, ref(UserRepository, "findAll"))).toBe(false);
  });

  it("within a superclass matches its members on every subclass", () => {
    const pointcut = P.within(BaseRepository);

    expect(matches(pointcut, ref(OrderRepository, "findAll"))).toBe(true);
    expect(matches(pointcut, ref(OrderRepository, "findOrders"))).toBe(false);
    expect(matches(pointcut, ref(UserRepository, "findOne"))).toBe(false);
  });

  it("within accepts several classes", () => {
    const pointcut = P.within(UserRepository, OrderRepository);

    expect(matches(pointcut, ref(UserRepository, "remove"))).toBe(true);
    expect(matches(pointcut, ref(OrderRepository, "findOrders"))).toBe(true);
    expect(matches(pointcut, ref(BaseRepository, "save"))).toBe(false);
  });

  it("target matches every member of the type and its subclasses", () => {
    const pointcut = P.target(BaseRepository);

    expect(matches(pointcut, ref(BaseRepository, "save"))).toBe(true);
    expect(matches(pointcut, ref(UserRepository, "remove"))).toBe(true);
    expect(matches(pointcut, ref(UserRepository, "findAll"))).toBe(true);
  });

  it("target of a subclass includes inherited members and excludes the superclass", () => {
    const pointcut = P.target(UserRepository);

    expect(matches(pointcut, ref(UserRepository, "findAll"))).toBe(true);
    expect(matches(pointcut, ref(BaseRepository, "findAll"))).toBe(false);
    expect(matches(pointcut, ref(OrderRepository, "findAll"))).toBe(false);
  });
});

describe("P.name", () => {
  it("matches a glob against the whole name", () => {
    const pointcut = P.name("find*");

    expect(matches(pointcut, ref(UserRepository, "findOne"))).toBe(true);
    expect(matches(pointcut, ref(UserRepository, "findByAccount"))).toBe(true);
    expect(matches(pointcut, ref(UserRepository, "remove"))).toBe(false);
    expect(matches(P.name("*One"), ref(UserRepository, "findOne"))).toBe(true);
    expect(matches(P.name("find"), ref(UserRepository, "findOne"))).toBe(false);
    expect(matches(P.name("f*d*t"), ref(UserRepository, "findByAccount"))).toBe(
      true,
    );
  });

  it("treats regular expression characters in a glob literally", () => {
    class Odd {
      $find(): void {}

      xfind(): void {}
    }

    expect(matches(P.name("$f*"), ref(Odd, "$find"))).toBe(true);
    expect(matches(P.name(".find"), ref(Odd, "xfind"))).toBe(false);
  });

  it("tests a RegExp without keeping state between members", () => {
    const pointcut = P.name(/^find/g);

    expect(matches(pointcut, ref(UserRepository, "findOne"))).toBe(true);
    expect(matches(pointcut, ref(UserRepository, "findAll"))).toBe(true);
    expect(matches(pointcut, ref(UserRepository, "save"))).toBe(false);
  });

  it("never matches a symbol-named member", () => {
    expect(matches(P.name("*"), ref(UserRepository, Symbol.iterator))).toBe(
      false,
    );
    expect(matches(P.all(), ref(UserRepository, Symbol.iterator))).toBe(true);
  });
});

describe("P.kind", () => {
  it("selects getters and setters as separate join points", () => {
    const getter = ref(UserRepository, "size", "getter");
    const setter = ref(UserRepository, "size", "setter");

    expect(matches(P.kind("getter"), getter)).toBe(true);
    expect(matches(P.kind("getter"), setter)).toBe(false);
    expect(matches(P.kind("setter"), setter)).toBe(true);
    expect(matches(P.kind("getter"), ref(UserRepository, "remove"))).toBe(
      false,
    );
  });

  it("selects methods and leaves accessors out", () => {
    expect(matches(P.kind("method"), ref(UserRepository, "remove"))).toBe(true);
    expect(
      matches(P.kind("method"), ref(UserRepository, "size", "getter")),
    ).toBe(false);
  });

  it("is the only designator that selects accessors", () => {
    const getter = ref(UserRepository, "size", "getter");

    expect(matches(P.name("size"), getter)).toBe(false);
    expect(matches(P.within(UserRepository), getter)).toBe(false);
    expect(matches(P.target(UserRepository), getter)).toBe(false);
    expect(matches(P.all(), getter)).toBe(false);
    expect(
      matches(P.within(UserRepository).and(P.kind("getter")), getter),
    ).toBe(true);
    expect(
      matches(P.within(OrderRepository).and(P.kind("getter")), getter),
    ).toBe(false);
  });
});

describe("annotation designators", () => {
  it("annotated matches a member that carries the annotation itself", () => {
    const pointcut = P.annotated(Audited);

    expect(matches(pointcut, ref(UserRepository, "remove"))).toBe(true);
    // The class carries Audited, the member does not.
    expect(matches(pointcut, ref(UserRepository, "findOne"))).toBe(false);
  });

  it("annotated follows an inherited method and not an override", () => {
    class Overriding extends BaseRepository {
      override findAll(): string[] {
        return [];
      }
    }

    expect(matches(P.annotated(Cached), ref(OrderRepository, "findAll"))).toBe(
      true,
    );
    expect(matches(P.annotated(Cached), ref(Overriding, "findAll"))).toBe(
      false,
    );
  });

  it("withinAnnotated matches members declared on an annotated class", () => {
    const pointcut = P.withinAnnotated(Audited);

    expect(matches(pointcut, ref(UserRepository, "findOne"))).toBe(true);
    expect(matches(pointcut, ref(UserRepository, "findAll"))).toBe(false);
    expect(matches(pointcut, ref(OrderRepository, "findOrders"))).toBe(false);
  });

  it("withinAnnotated sees an annotation inherited by the declaring class", () => {
    class AdminRepository extends UserRepository {
      purge(): void {}
    }

    expect(
      matches(P.withinAnnotated(Audited), ref(AdminRepository, "purge")),
    ).toBe(true);
  });

  it("targetAnnotated matches every member of an annotated target class", () => {
    const pointcut = P.targetAnnotated(Audited);

    expect(matches(pointcut, ref(UserRepository, "findOne"))).toBe(true);
    expect(matches(pointcut, ref(UserRepository, "findAll"))).toBe(true);
    expect(matches(pointcut, ref(BaseRepository, "findAll"))).toBe(false);
  });

  it("accept Reflector.createDecorator decorators", () => {
    @Roles(["class"])
    class Guarded {
      run(): void {}
    }

    expect(matches(P.annotated(Roles), ref(UserRepository, "remove"))).toBe(
      true,
    );
    expect(matches(P.annotated(Roles), ref(UserRepository, "findOne"))).toBe(
      false,
    );
    expect(matches(P.withinAnnotated(Roles), ref(Guarded, "run"))).toBe(true);
    expect(matches(P.targetAnnotated(Roles), ref(Guarded, "run"))).toBe(true);
    expect(
      matches(P.targetAnnotated(Roles), ref(UserRepository, "remove")),
    ).toBe(false);
  });

  it("guarantee the annotation name, and nothing for a Nest decorator", () => {
    expect([...guaranteedAnnotations(P.annotated(Cached))]).toEqual(["Cached"]);
    expect([...guaranteedAnnotations(P.withinAnnotated(Audited))]).toEqual([
      "Audited",
    ]);
    expect([...guaranteedAnnotations(P.targetAnnotated(Audited))]).toEqual([
      "Audited",
    ]);
    expect(guaranteedAnnotations(P.annotated(Roles)).size).toBe(0);
  });

  it("reject a value that is not an annotation", () => {
    const decorator = (() => () => undefined) as unknown as typeof Roles;

    expect(() => P.annotated(decorator)).toThrow(AspectConfigurationError);
  });
});

describe("P.args", () => {
  const find = ref(UserRepository, "findByAccount");

  it("is a runtime matcher that may match every member statically", () => {
    const pointcut = P.args(Account);

    expect(pointcut.methodMatcher.isRuntime).toBe(true);
    expect(matches(pointcut, find)).toBe(true);
    expect(matches(pointcut, ref(UserRepository, "remove"))).toBe(true);
  });

  it("matches arguments by instanceof, subclasses included", () => {
    const pointcut = P.args(Account);

    expect(matchesCall(pointcut, find, [new Account("a")])).toBe(true);
    expect(matchesCall(pointcut, find, [new SavingsAccount("a")])).toBe(true);
    expect(matchesCall(pointcut, find, [{ id: "a" }])).toBe(false);
    expect(matchesCall(P.args(SavingsAccount), find, [new Account("a")])).toBe(
      false,
    );
  });

  it("requires the exact argument count without REST", () => {
    const pointcut = P.args(Account);

    expect(matchesCall(pointcut, find, [])).toBe(false);
    expect(matchesCall(pointcut, find, [new Account("a"), 1])).toBe(false);
    expect(matchesCall(P.args(), find, [])).toBe(true);
    expect(matchesCall(P.args(), find, [1])).toBe(false);
  });

  it("matches one argument of any value with ANY", () => {
    const pointcut = P.args(P.ANY, Number);

    expect(matchesCall(pointcut, find, [undefined, 1])).toBe(true);
    expect(matchesCall(pointcut, find, ["x", 1])).toBe(true);
    expect(matchesCall(pointcut, find, [1])).toBe(false);
  });

  it("matches zero or more trailing arguments with REST", () => {
    const pointcut = P.args(Account, P.REST);

    expect(matchesCall(pointcut, find, [new Account("a")])).toBe(true);
    expect(matchesCall(pointcut, find, [new Account("a"), 1, 2])).toBe(true);
    expect(matchesCall(pointcut, find, [])).toBe(false);
    expect(matchesCall(pointcut, find, [1, new Account("a")])).toBe(false);
    expect(matchesCall(P.args(P.REST), find, [])).toBe(true);
  });

  it("matches primitives with their wrapper classes", () => {
    const pointcut = P.args(String, Number, Boolean);

    expect(matchesCall(pointcut, find, ["a", 1, true])).toBe(true);
    expect(matchesCall(pointcut, find, [1, "a", true])).toBe(false);
    expect(matchesCall(pointcut, find, ["a", 1, null])).toBe(false);
    expect(matchesCall(P.args(BigInt, Symbol), find, [1n, Symbol()])).toBe(
      true,
    );
    expect(matchesCall(P.args(BigInt, Symbol), find, [1, "symbol"])).toBe(
      false,
    );
  });

  it("rejects REST anywhere but the last position", () => {
    expect(() => P.args(P.REST, Account)).toThrow(AspectConfigurationError);
  });
});

describe("P.bean", () => {
  const TOKEN = Symbol("userRepository");

  class AppModule {}

  function registered(...tokens: (string | symbol | Class)[]): MethodRef {
    return ref(UserRepository, "remove", "method", {
      beans: tokens.map((token) => ({ token, module: AppModule })),
    });
  }

  it("matches a string against string tokens, class names and symbol descriptions", () => {
    expect(
      matches(P.bean("USER_REPOSITORY"), registered("USER_REPOSITORY")),
    ).toBe(true);
    expect(matches(P.bean("UserRepository"), registered(UserRepository))).toBe(
      true,
    );
    expect(matches(P.bean("userRepository"), registered(TOKEN))).toBe(true);
    expect(matches(P.bean("User"), registered(UserRepository))).toBe(false);
  });

  it("treats * in a string as a wildcard", () => {
    const pointcut = P.bean("User*");

    expect(matches(pointcut, registered(UserRepository))).toBe(true);
    expect(matches(pointcut, registered("USER_REPOSITORY"))).toBe(false);
  });

  it("tests a RegExp against the same text", () => {
    const pointcut = P.bean(/Repository$/);

    expect(matches(pointcut, registered(UserRepository))).toBe(true);
    expect(matches(pointcut, registered(TOKEN))).toBe(true);
    expect(matches(pointcut, registered("USER_REPO"))).toBe(false);
  });

  it("matches a class against the identical token only", () => {
    expect(matches(P.bean(UserRepository), registered(UserRepository))).toBe(
      true,
    );
    expect(matches(P.bean(BaseRepository), registered(UserRepository))).toBe(
      false,
    );
    expect(matches(P.bean(UserRepository), registered("UserRepository"))).toBe(
      false,
    );
  });

  it("matches when any registration of the class matches", () => {
    expect(matches(P.bean("ALIAS"), registered(UserRepository, "ALIAS"))).toBe(
      true,
    );
  });

  it("matches nothing for a class outside a container", () => {
    expect(matches(P.bean(/./), ref(UserRepository, "remove"))).toBe(false);
  });
});

describe("P.inModule", () => {
  class AppModule {}

  class FeatureModule {}

  class DataModule {}

  class OtherModule {}

  // AppModule -> FeatureModule -> DataModule
  const imports = new Map<Class, Class[]>([
    [AppModule, [FeatureModule]],
    [FeatureModule, [DataModule]],
  ]);

  function reachesModule(root: Class, imported: Class): boolean {
    return (imports.get(root) ?? []).some(
      (module) => module === imported || reachesModule(module, imported),
    );
  }

  function declaredIn(...modules: Class[]): MethodRef {
    return ref(UserRepository, "remove", "method", {
      beans: modules.map((module) => ({ token: UserRepository, module })),
      reachesModule,
    });
  }

  it("matches classes the module declares itself", () => {
    expect(matches(P.inModule(DataModule), declaredIn(DataModule))).toBe(true);
    expect(matches(P.inModule(FeatureModule), declaredIn(DataModule))).toBe(
      false,
    );
    expect(matches(P.inModule(AppModule), declaredIn(DataModule))).toBe(false);
  });

  it("follows imports at any depth when transitive", () => {
    const options = { transitive: true };

    expect(
      matches(P.inModule(AppModule, options), declaredIn(DataModule)),
    ).toBe(true);
    expect(
      matches(P.inModule(FeatureModule, options), declaredIn(DataModule)),
    ).toBe(true);
    expect(
      matches(P.inModule(DataModule, options), declaredIn(DataModule)),
    ).toBe(true);
    expect(
      matches(P.inModule(DataModule, options), declaredIn(FeatureModule)),
    ).toBe(false);
    expect(
      matches(P.inModule(AppModule, options), declaredIn(OtherModule)),
    ).toBe(false);
  });

  it("matches when any registration of the class is in the module", () => {
    expect(
      matches(P.inModule(DataModule), declaredIn(OtherModule, DataModule)),
    ).toBe(true);
  });
});

describe("P.metadata", () => {
  function Timeout(ms: number): MethodDecorator {
    return (target, key) => {
      Reflect.defineMetadata("timeout", ms, target, key);
    };
  }

  class Jobs {
    @Timeout(500)
    slow(): void {}

    @Timeout(5)
    fast(): void {}

    none(): void {}
  }

  class ScheduledJobs extends Jobs {
    override slow(): void {}
  }

  it("matches metadata stored on the member function", () => {
    const pointcut = P.metadata("roles");

    expect(matches(pointcut, ref(UserRepository, "remove"))).toBe(true);
    expect(matches(pointcut, ref(UserRepository, "findOne"))).toBe(false);
  });

  it("matches metadata stored for the property of the declaring prototype", () => {
    const pointcut = P.metadata("timeout");

    expect(matches(pointcut, ref(Jobs, "slow"))).toBe(true);
    expect(matches(pointcut, ref(Jobs, "none"))).toBe(false);
    expect(matches(pointcut, ref(ScheduledJobs, "fast"))).toBe(true);
    expect(matches(pointcut, ref(ScheduledJobs, "slow"))).toBe(false);
  });

  it("filters by the value with a predicate", () => {
    const seen: unknown[] = [];
    const pointcut = P.metadata("timeout", (value, method) => {
      seen.push(method.name);
      return (value as number) > 100;
    });

    expect(matches(pointcut, ref(Jobs, "slow"))).toBe(true);
    expect(matches(pointcut, ref(Jobs, "fast"))).toBe(false);
    expect(matches(pointcut, ref(Jobs, "none"))).toBe(false);
    expect(seen).toEqual(["slow", "fast"]);
  });
});

describe("P.matching", () => {
  it("combines a custom class filter and method matcher", () => {
    const pointcut = P.matching({
      classFilter: { matches: (classRef) => classRef.type === UserRepository },
      methodMatcher: {
        isRuntime: false,
        matches: (method) => method.original.length === 1,
      },
    });

    expect(matches(pointcut, ref(UserRepository, "remove"))).toBe(true);
    expect(matches(pointcut, ref(UserRepository, "findAll"))).toBe(false);
    expect(matches(pointcut, ref(OrderRepository, "findOne"))).toBe(false);
  });

  it("matches everything a missing part would filter", () => {
    const pointcut = P.matching({
      classFilter: { matches: (classRef) => classRef.type === OrderRepository },
    });

    expect(matches(pointcut, ref(OrderRepository, "save"))).toBe(true);
    expect(matches(pointcut, ref(UserRepository, "save"))).toBe(false);
  });

  it("keeps a runtime method matcher", () => {
    const pointcut = P.matching({
      methodMatcher: {
        isRuntime: true,
        matches: (method) => method.name === "save",
        matchesRuntime: (_method, args) => args[0] === "match",
      },
    });
    const save = ref(UserRepository, "save");

    expect(pointcut.methodMatcher.isRuntime).toBe(true);
    expect(matches(pointcut, ref(UserRepository, "remove"))).toBe(false);
    expect(matchesCall(pointcut, save, ["match"])).toBe(true);
    expect(matchesCall(pointcut, save, ["other"])).toBe(false);
  });
});
