import { isObject } from "./util";

/**
 * Prototype property that names the error class. It is registered with
 * `Symbol.for`, so `instanceof` recognizes the errors of another copy of the
 * package, such as the CommonJS build next to the ES module build.
 */
const ERROR_KIND: unique symbol = Symbol.for("nestjs-aspect:error-kind");

/**
 * Marks the instances of `type` and makes `instanceof type` accept every
 * object that carries the mark. A subclass keeps the prototype chain test.
 */
function brand(type: abstract new (...args: any[]) => Error, kind: string) {
  Object.defineProperty(type.prototype, ERROR_KIND, { value: kind });
  Object.defineProperty(type, Symbol.hasInstance, {
    value(this: unknown, value: unknown): boolean {
      return this === type
        ? isObject(value) && value[ERROR_KIND] === kind
        : Function.prototype[Symbol.hasInstance].call(this, value);
    },
  });
}

/**
 * Thrown while the application bootstraps when aspects, pointcuts or advice
 * are misconfigured.
 */
export class AopConfigurationError extends Error {
  static {
    brand(AopConfigurationError, "AopConfigurationError");
  }

  override readonly name = "AopConfigurationError";
}

/**
 * Thrown at run time when advice is used in a way its join point does not
 * support, such as asynchronous advice on a synchronous join point.
 */
export class AopUsageError extends Error {
  static {
    brand(AopUsageError, "AopUsageError");
  }

  override readonly name = "AopUsageError";
}

/**
 * Thrown when a woven method is invoked before the instance of an aspect that
 * advises it exists.
 */
export class AopNotReadyError extends Error {
  static {
    brand(AopNotReadyError, "AopNotReadyError");
  }

  override readonly name = "AopNotReadyError";
}
