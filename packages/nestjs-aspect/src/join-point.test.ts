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

    const jp = createJoinPoint(invocation);

    expect(jp.kind).toBe("method");
    expect(jp.target).toBe(invocation.target);
    expect(jp.args).toEqual([7]);
    expect(jp.signature).toEqual({
      name: "find",
      declaringType: BaseRepository,
      targetType: UserRepository,
    });
    expect(jp.isAsync).toBe(false);
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
    const jp = createJoinPoint(invocationOf("find", [7]));

    expect(jp.findAnnotation(Absent)).toBeUndefined();
    expect(() => jp.annotation(Absent as never)).toThrow(AspectUsageError);
    expect(() => jp.annotation(Absent as never)).toThrow(
      /UserRepository\.find\(7\).*@Absent/,
    );
  });

  it("accepts a present annotation that carries no value", () => {
    const jp = createJoinPoint(invocationOf("find", [7]));

    expect(jp.annotation(Marker as never)).toBeUndefined();
  });

  it("renders as TargetType.name(arguments)", () => {
    const jp = createJoinPoint(invocationOf("find", [7, { limit: 1 }]));

    expect(jp.toString()).toBe("UserRepository.find(7, Object)");
    expect(`${jp}`).toBe("UserRepository.find(7, Object)");
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
      around(jp: ProceedingJoinPoint<AnyShape>): unknown {
        seen.push(jp);
        return jp.proceedWith(8);
      }

      @Before(named("find"))
      first(jp: JoinPoint<AnyShape>): void {
        seen.push(jp);
      }

      @Before(named("find"))
      second(jp: JoinPoint<AnyShape>): void {
        seen.push(jp);
      }
    }
    const repository = weave(new UserRepository(), [new Trace()]);

    expect(repository.find(7)).toBe("row 8");
    expect(seen.map((jp) => jp.toString())).toEqual([
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
