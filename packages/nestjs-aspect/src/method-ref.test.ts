import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { AspectConfigurationError } from "./errors";
import { createClassRef, createMethodRef, ORIGINAL } from "./method-ref";

function Marked(): MethodDecorator {
  return () => undefined;
}

class Base {
  inherited(): string {
    return "base";
  }

  overridden(): string {
    return "base";
  }

  get label(): string {
    return "base";
  }

  set label(_value: string) {}
}

class Concrete extends Base {
  override overridden(): string {
    return "concrete";
  }

  async native(): Promise<number> {
    return 1;
  }

  @Marked()
  declared(): Promise<number> {
    return Promise.resolve(1);
  }

  plain(): number {
    return 1;
  }
}

describe("createMethodRef", () => {
  const classRef = createClassRef(Concrete);

  it("reports the class that defines an inherited member as declaring type", () => {
    const ref = createMethodRef(classRef, "inherited");

    expect(ref.declaringType).toBe(Base);
    expect(ref.targetType).toBe(Concrete);
    expect(ref.original).toBe(Base.prototype.inherited);
  });

  it("reports the overriding class as declaring type", () => {
    const ref = createMethodRef(classRef, "overridden");

    expect(ref.declaringType).toBe(Concrete);
    expect(ref.original).toBe(Concrete.prototype.overridden);
  });

  it("describes getters and setters as separate join points", () => {
    const descriptor = Object.getOwnPropertyDescriptor(Base.prototype, "label");

    expect(createMethodRef(classRef, "label", "getter").original).toBe(
      descriptor?.get,
    );
    expect(createMethodRef(classRef, "label", "setter").original).toBe(
      descriptor?.set,
    );
  });

  it("detects asynchronous methods natively and through design:returntype", () => {
    expect(createMethodRef(classRef, "native").isAsync).toBe(true);
    expect(createMethodRef(classRef, "declared").isAsync).toBe(true);
    expect(createMethodRef(classRef, "plain").isAsync).toBe(false);
  });

  it("rejects a missing member and a member of another kind", () => {
    expect(() => createMethodRef(classRef, "missing")).toThrow(
      AspectConfigurationError,
    );
    expect(() => createMethodRef(classRef, "label")).toThrow(
      AspectConfigurationError,
    );
    expect(() => createMethodRef(classRef, "plain", "getter")).toThrow(
      AspectConfigurationError,
    );
  });

  it("sees through dispatcher stubs on a woven prototype", () => {
    class Parent {
      run(): string {
        return "parent";
      }
    }
    class Child extends Parent {}
    const original = Parent.prototype.run;
    const stub = Object.assign(
      function (this: Child) {
        return original.call(this);
      },
      { [ORIGINAL]: original },
    );
    Object.defineProperty(Child.prototype, "run", {
      value: stub,
      writable: true,
      configurable: true,
    });

    const ref = createMethodRef(createClassRef(Child), "run");

    expect(ref.original).toBe(original);
    expect(ref.declaringType).toBe(Parent);
  });

  it("keeps the declaring type when the stub is not directly below it", () => {
    class Parent {
      run(): string {
        return "parent";
      }
    }
    class Middle extends Parent {}
    class Child extends Middle {}
    class Leaf extends Child {}
    Object.defineProperty(Child.prototype, "run", {
      value: Object.assign(() => "stub", { [ORIGINAL]: Parent.prototype.run }),
      writable: true,
      configurable: true,
    });

    for (const type of [Child, Leaf]) {
      const ref = createMethodRef(createClassRef(type), "run");

      expect(ref.original).toBe(Parent.prototype.run);
      expect(ref.declaringType).toBe(Parent);
    }
  });

  it("stops at a prototype that defines another function", () => {
    class Parent {
      run(): string {
        return "parent";
      }
    }
    class Middle extends Parent {
      override run(): string {
        return "middle";
      }
    }
    class Child extends Middle {}
    class Leaf extends Child {}

    expect(createMethodRef(createClassRef(Leaf), "run").declaringType).toBe(
      Middle,
    );
  });
});

describe("createClassRef", () => {
  it("describes a class outside a container without registrations", () => {
    const ref = createClassRef(Concrete);

    expect(ref.beans).toEqual([]);
    expect(ref.reachesModule(Base, Concrete)).toBe(false);
  });
});
