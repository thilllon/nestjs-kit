/**
 * Thrown while the application bootstraps when aspects, pointcuts or advice
 * are misconfigured.
 */
export class AopConfigurationError extends Error {
  override readonly name = "AopConfigurationError";
}

/**
 * Thrown at run time when advice is used in a way its join point does not
 * support, such as asynchronous advice on a synchronous join point.
 */
export class AopUsageError extends Error {
  override readonly name = "AopUsageError";
}

/**
 * Thrown when a woven method is invoked before the instance of an aspect that
 * advises it exists.
 */
export class AopNotReadyError extends Error {
  override readonly name = "AopNotReadyError";
}
