import { createAnnotation } from "nestjs-aspect";

export interface RetryOptions {
  /** Total number of calls, the first one included. */
  attempts: number;
  /** Upper limit of the wait before the second call; it doubles afterwards. */
  backoffMilliseconds: number;
}

/** A failure after which another attempt can succeed. */
export class TransientError extends Error {}

/**
 * Marks a method that `RetryAspect` calls again after a `TransientError`.
 * The method must be safe to repeat: a call that sends an idempotency key,
 * or a transaction, which has rolled back when it fails.
 *
 * It applies only to methods that return a promise, and the application
 * fails to start when no advisor whose pointcut refers to the annotation
 * advises a method that carries it.
 */
export const Retryable = createAnnotation<
  "Retryable",
  RetryOptions,
  (...args: any[]) => Promise<unknown>
>("Retryable", { requiresAdvice: true });
