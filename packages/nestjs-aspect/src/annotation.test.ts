import "reflect-metadata";
import { Reflector } from "@nestjs/core";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  createAnnotation,
  findAnnotation,
  hasClassAnnotation,
  hasMethodAnnotation,
  isAnnotation,
  listAnnotations,
  requiredAdviceAnnotations,
} from "./annotation";
import { AspectConfigurationError } from "./errors";
import { createClassRef, createMethodRef, ORIGINAL } from "./method-ref";
import type { Class, JoinPointKind, MethodRef } from "./types";

interface RetryOptions {
  attempts: number;
}

const Retryable = createAnnotation<"Retryable", RetryOptions>("Retryable", {
  requiresAdvice: true,
});
const Audited = createAnnotation<"Audited">("Audited");
const Tagged = createAnnotation<"Tagged", string>("Tagged");
const Roles = Reflector.createDecorator<string[]>();

function ref(
  type: Class,
  name: string | symbol,
  kind: JoinPointKind = "method",
): MethodRef {
  return createMethodRef(createClassRef(type), name, kind);
}

@Tagged("base")
class BaseService {
  @Retryable({ attempts: 3 })
  inherited(): void {}

  @Tagged("method")
  overridden(): void {}

  plain(): void {}
}

class ChildService extends BaseService {
  override overridden(): void {}

  own(): void {}
}

@Tagged("grandchild")
@Audited()
class GrandchildService extends ChildService {
  mine(): void {}
}

describe("createAnnotation", () => {
  it("rejects an empty name", () => {
    expect(() => createAnnotation("")).toThrow(AspectConfigurationError);
  });

  it("is recognized by isAnnotation, unlike other decorators factories", () => {
    expect(isAnnotation(Audited)).toBe(true);
    expect(isAnnotation(Roles)).toBe(false);
    expect(isAnnotation(() => undefined)).toBe(false);
    expect(isAnnotation(undefined)).toBe(false);
  });

  it("identifies an annotation by its name", () => {
    const SameName = createAnnotation<"Tagged", string>("Tagged");

    expect(findAnnotation(SameName, ref(BaseService, "overridden"))).toEqual({
      value: "method",
      source: "method",
    });
  });
});

describe("findAnnotation", () => {
  it("returns the typed value stored on a method", () => {
    const match = findAnnotation(Retryable, ref(BaseService, "inherited"));

    expect(match).toEqual({ value: { attempts: 3 }, source: "method" });
    expectTypeOf(match?.value).toEqualTypeOf<RetryOptions | undefined>();
  });

  it("finds a valueless annotation with an undefined value", () => {
    const match = findAnnotation(Audited, ref(GrandchildService, "mine"));

    expect(match).toEqual({ value: undefined, source: "declaringType" });
  });

  it("prefers the method over the declaring class", () => {
    expect(findAnnotation(Tagged, ref(BaseService, "overridden"))).toEqual({
      value: "method",
      source: "method",
    });
  });

  it("falls back to the declaring class", () => {
    expect(findAnnotation(Tagged, ref(BaseService, "plain"))).toEqual({
      value: "base",
      source: "declaringType",
    });
  });

  it("prefers the declaring class over the target class for an inherited method", () => {
    expect(findAnnotation(Tagged, ref(GrandchildService, "plain"))).toEqual({
      value: "base",
      source: "declaringType",
    });
  });

  it("falls back to the target class when the declaring class chain has none", () => {
    expect(
      findAnnotation(Audited, ref(GrandchildService, "inherited")),
    ).toEqual({ value: undefined, source: "targetType" });
  });

  it("inherits class annotations along the superclass chain", () => {
    expect(findAnnotation(Tagged, ref(ChildService, "own"))).toEqual({
      value: "base",
      source: "declaringType",
    });
    expect(findAnnotation(Tagged, ref(GrandchildService, "mine"))).toEqual({
      value: "grandchild",
      source: "declaringType",
    });
  });

  it("does not carry a method annotation to an override", () => {
    const overridden = ref(ChildService, "overridden");

    expect(hasMethodAnnotation(Tagged, overridden)).toBe(false);
    expect(findAnnotation(Tagged, overridden)).toEqual({
      value: "base",
      source: "declaringType",
    });
  });

  it("keeps a method annotation for a subclass that inherits the method", () => {
    expect(
      findAnnotation(Retryable, ref(GrandchildService, "inherited")),
    ).toEqual({ value: { attempts: 3 }, source: "method" });
  });

  it("returns undefined for an absent annotation", () => {
    expect(
      findAnnotation(Retryable, ref(BaseService, "plain")),
    ).toBeUndefined();
    expect(findAnnotation(Audited, ref(ChildService, "own"))).toBeUndefined();
  });

  it("keeps the annotations of the superclass apart from those of a subclass", () => {
    expect(hasClassAnnotation(Audited, GrandchildService)).toBe(true);
    expect(hasClassAnnotation(Audited, ChildService)).toBe(false);
    expect(hasClassAnnotation(Tagged, ChildService)).toBe(true);
  });

  it("stores several annotations on one member independently", () => {
    class Stacked {
      @Audited()
      @Tagged("first")
      @Retryable({ attempts: 1 })
      run(): void {}
    }
    const run = ref(Stacked, "run");

    expect(findAnnotation(Tagged, run)?.value).toBe("first");
    expect(findAnnotation(Retryable, run)?.value).toEqual({ attempts: 1 });
    expect(hasMethodAnnotation(Audited, run)).toBe(true);
  });

  it("reads member annotations through a dispatcher stub", () => {
    class Woven {
      @Tagged("woven")
      run(): void {}
    }
    const original = Woven.prototype.run;
    Object.defineProperty(Woven.prototype, "run", {
      value: Object.assign(() => undefined, { [ORIGINAL]: original }),
      writable: true,
      configurable: true,
    });

    expect(findAnnotation(Tagged, ref(Woven, "run"))?.value).toBe("woven");
  });

  it("reads annotations applied to accessors", () => {
    class WithAccessor {
      get label(): string {
        return "label";
      }
    }
    Reflect.decorate(
      [Tagged("getter") as MethodDecorator],
      WithAccessor.prototype,
      "label",
      Object.getOwnPropertyDescriptor(WithAccessor.prototype, "label"),
    );

    expect(
      findAnnotation(Tagged, ref(WithAccessor, "label", "getter")),
    ).toEqual({ value: "getter", source: "method" });
  });
});

describe("Reflector.createDecorator interop", () => {
  const Flag = Reflector.createDecorator<string>();

  @Roles(["class"])
  class Guarded {
    @Roles(["admin"])
    restricted(): void {}

    open(): void {}
  }

  class GuardedChild extends Guarded {
    extra(): void {}
  }

  it("reads the value from the method", () => {
    const match = findAnnotation(Roles, ref(Guarded, "restricted"));

    expect(match).toEqual({ value: ["admin"], source: "method" });
    expectTypeOf(match?.value).toEqualTypeOf<string[] | undefined>();
    expect(hasMethodAnnotation(Roles, ref(Guarded, "restricted"))).toBe(true);
    expect(hasMethodAnnotation(Roles, ref(Guarded, "open"))).toBe(false);
  });

  it("falls back to the class and its superclasses", () => {
    expect(findAnnotation(Roles, ref(Guarded, "open"))).toEqual({
      value: ["class"],
      source: "declaringType",
    });
    expect(findAnnotation(Roles, ref(GuardedChild, "extra"))).toEqual({
      value: ["class"],
      source: "declaringType",
    });
    expect(hasClassAnnotation(Roles, GuardedChild)).toBe(true);
  });

  it("returns undefined for a decorator that was not applied", () => {
    expect(findAnnotation(Flag, ref(Guarded, "restricted"))).toBeUndefined();
    expect(hasClassAnnotation(Flag, Guarded)).toBe(false);
  });

  it("rejects a function that is not an annotation", () => {
    const notAnAnnotation = (() => undefined) as unknown as typeof Roles;

    expect(() => findAnnotation(notAnAnnotation, ref(Guarded, "open"))).toThrow(
      AspectConfigurationError,
    );
  });
});

describe("listAnnotations", () => {
  it("resolves one record per name in lookup order", () => {
    const records = listAnnotations(ref(GrandchildService, "overridden"));

    expect(records).toEqual(
      expect.arrayContaining([
        { name: "Tagged", value: "base", requiresAdvice: false },
        { name: "Audited", value: undefined, requiresAdvice: false },
      ]),
    );
    expect(records).toHaveLength(2);
  });

  it("lists nothing for a member without annotations", () => {
    class Bare {
      run(): void {}
    }

    expect(listAnnotations(ref(Bare, "run"))).toEqual([]);
  });
});

describe("requiredAdviceAnnotations", () => {
  it("names the annotations that require advice on the join point", () => {
    expect(requiredAdviceAnnotations(ref(ChildService, "inherited"))).toEqual([
      "Retryable",
    ]);
    expect(requiredAdviceAnnotations(ref(ChildService, "plain"))).toEqual([]);
  });

  it("applies a class-level annotation to every member of the class", () => {
    const Transactional = createAnnotation<"Transactional">("Transactional", {
      requiresAdvice: true,
    });

    @Transactional()
    class Repository {
      save(): void {}
    }

    expect(requiredAdviceAnnotations(ref(Repository, "save"))).toEqual([
      "Transactional",
    ]);
  });
});
