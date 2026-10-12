import "reflect-metadata";
import { Reflector } from "@nestjs/core";
import { describe, expect, it, vi } from "vitest";
import { createAnnotation } from "./annotation";
import {
  createAdviceAdapterRegistry,
  createReturnValueAdapterRegistry,
} from "./advice";
import { Around, Aspect, Before } from "./aspect-decorators";
import { named, weave } from "./aspect-fixture";
import { AspectUsageError } from "./errors";
import { buildChain, Invocation } from "./invocation";
import {
  createJoinPoint,
  createProceedingJoinPoint,
  formatArgument,
} from "./join-point";
import { createClassRef, createMethodRef } from "./method-ref";
import type { AnyShape, JoinPoint, ProceedingJoinPoint } from "./types";

const Audited = createAnnotation<"Audited", { level: string }>("Audited");
const Marker = createAnnotation<"Marker">("Marker");
const Absent = createAnnotation<"Absent">("Absent");
const Roles = Reflector.createDecorator<string[]>();

@Marker()
class BaseRepository {
  @Audited({ level: "high" })
  find(id: number, options?: object): string {
    return `row ${id} ${options ? "with options" : ""}`.trim();
  }

  get size(): number {
    return 0;
  }
}

@Audited({ level: "low" })
class UserRepository extends BaseRepository {
  @Roles(["admin"])
  async load(id: number): Promise<string> {
    return `user ${id}`;
  }
}

function invocationOf(
  name: string,
  args: readonly unknown[],
  kind: "method" | "getter" = "method",
): Invocation {
  const method = createMethodRef(createClassRef(UserRepository), name, kind);
  const chain = buildChain(method, [], {
    adviceAdapters: createAdviceAdapterRegistry(),
    returnValues: createReturnValueAdapterRegistry(),
  });
  return new Invocation(chain, new UserRepository(), args);
}

describe("createJoinPoint", () => {
  it("describes the target, the arguments and the signature of the call", () => {
    const invocation = invocationOf("find", [7]);

    const joinPoint = createJoinPoint(invocation);

    expect(joinPoint.kind).toBe("method");
    expect(joinPoint.target).toBe(invocation.target);
    expect(joinPoint.args).toEqual([7]);
    expect(joinPoint.signature).toEqual({
      name: "find",
      declaringType: BaseRepository,
      targetType: UserRepository,
    });
    expect(joinPoint.isAsync).toBe(false);
  });

  it("reports asynchronous methods and accessor kinds", () => {
    expect(createJoinPoint(invocationOf("load", [1])).isAsync).toBe(true);
    expect(createJoinPoint(invocationOf("size", [], "getter")).kind).toBe(
      "getter",
    );
  });

  it("looks an annotation up on the method before the target class", () => {
    const find = createJoinPoint(invocationOf("find", [7]));
    const load = createJoinPoint(invocationOf("load", [1]));

    expect(find.annotation(Audited as never)).toEqual({ level: "high" });
    expect(find.findAnnotation(Audited)).toEqual({ level: "high" });
    expect(load.findAnnotation(Audited)).toEqual({ level: "low" });
  });

  it("reads a Nest Reflector decorator through findAnnotation()", () => {
    expect(
      createJoinPoint(invocationOf("load", [1])).findAnnotation(Roles),
    ).toEqual(["admin"]);
    expect(
      createJoinPoint(invocationOf("find", [7])).findAnnotation(Roles),
    ).toBeUndefined();
  });

  it("raises AspectUsageError from annotation() and returns undefined from findAnnotation() when absent", () => {
    const joinPoint = createJoinPoint(invocationOf("find", [7]));

    expect(joinPoint.findAnnotation(Absent)).toBeUndefined();
    expect(() => joinPoint.annotation(Absent as never)).toThrow(
      AspectUsageError,
    );
    expect(() => joinPoint.annotation(Absent as never)).toThrow(
      /UserRepository\.find\(7\).*@Absent/,
    );
  });

  it("accepts a present annotation that carries no value", () => {
    const joinPoint = createJoinPoint(invocationOf("find", [7]));

    expect(joinPoint.annotation(Marker as never)).toBeUndefined();
  });

  it("renders as TargetType.name(arguments)", () => {
    const joinPoint = createJoinPoint(invocationOf("find", [7, { limit: 1 }]));

    expect(joinPoint.toString()).toBe("UserRepository.find(7, Object)");
    expect(`${joinPoint}`).toBe("UserRepository.find(7, Object)");
  });
});

describe("createProceedingJoinPoint", () => {
  it("has the join point members and can be destructured", () => {
    const invocation = invocationOf("find", [7]);

    const { proceed, proceedWith, args, signature } =
      createProceedingJoinPoint(invocation);

    expect(args).toEqual([7]);
    expect(signature.name).toBe("find");
    expect(proceed()).toBe("row 7");
    expect(proceed()).toBe("row 7");
    expect(proceedWith(8, {})).toBe("row 8 with options");
  });
});

describe("join points in advice", () => {
  it("are shared by the advice of one invocation and follow replaced arguments", () => {
    const seen: JoinPoint<AnyShape>[] = [];

    @Aspect()
    class Trace {
      @Around(named("find"))
      around(joinPoint: ProceedingJoinPoint<AnyShape>): unknown {
        seen.push(joinPoint);
        return joinPoint.proceedWith(8);
      }

      @Before(named("find"))
      first(joinPoint: JoinPoint<AnyShape>): void {
        seen.push(joinPoint);
      }

      @Before(named("find"))
      second(joinPoint: JoinPoint<AnyShape>): void {
        seen.push(joinPoint);
      }
    }
    const repository = weave(new UserRepository(), [new Trace()]);

    expect(repository.find(7)).toBe("row 8");
    expect(seen.map((joinPoint) => joinPoint.toString())).toEqual([
      "UserRepository.find(7)",
      "UserRepository.find(8)",
      "UserRepository.find(8)",
    ]);
    expect(seen[1]).toBe(seen[2]);
    expect(seen[0].target).toBe(repository);
  });
});

describe("formatArgument", () => {
  it("renders primitives as literals", () => {
    expect(formatArgument(1)).toBe("1");
    expect(formatArgument(true)).toBe("true");
    expect(formatArgument(10n)).toBe("10n");
    expect(formatArgument(null)).toBe("null");
    expect(formatArgument(undefined)).toBe("undefined");
    expect(formatArgument(Symbol("tag"))).toBe("Symbol(tag)");
    expect(formatArgument('say "hi"')).toBe('"say \\"hi\\""');
  });

  it("truncates long strings", () => {
    const rendered = formatArgument("x".repeat(500));

    expect(rendered.length).toBeLessThan(50);
    expect(rendered.endsWith('..."')).toBe(true);
  });

  it("renders functions, arrays and objects by name or size", () => {
    class Order {}
    function handler(): void {}

    expect(formatArgument(handler)).toBe("[Function handler]");
    expect(formatArgument(() => undefined)).toBe("[Function]");
    expect(formatArgument([1, 2, 3])).toBe("Array(3)");
    expect(formatArgument(new Order())).toBe("Order");
    expect(formatArgument({ a: 1 })).toBe("Object");
    expect(formatArgument(Object.create(null))).toBe("Object");
  });

  it("renders an object that cannot be inspected or has no named class of its own as Object", () => {
    class Money {}
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();

    expect(formatArgument(revocable.proxy)).toBe("Object");
    expect(formatArgument(new (class {})())).toBe("Object");
    expect(formatArgument(Object.create(Object.create(null)))).toBe("Object");
    // The prototype is an instance, which inherits its constructor.
    expect(formatArgument(Object.create(new Money()))).toBe("Object");
  });

  it("does not call user code", () => {
    const called = vi.fn();
    const value = {
      toJSON: called,
      toString: called,
      get constructor() {
        called();
        return Object;
      },
    };

    expect(formatArgument(value)).toBe("Object");
    expect(called).not.toHaveBeenCalled();
  });
});
