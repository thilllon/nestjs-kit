import { createAnnotation } from "nestjs-aspect";

export interface RetryOptions {
  /** Total number of calls, the first one included. */
  attempts: number;
}

/** A failure that a later call may not repeat. */
export class TransientError extends Error {}

/**
 * Marks a method that `RetryAspect` calls again after a `TransientError`.
 * It applies only to methods that return a promise, and the application
 * fails to start when no advice matches a method that carries it.
 */
export const Retryable = createAnnotation<
  "Retryable",
  RetryOptions,
  (...args: any[]) => Promise<unknown>
>("Retryable", { requiresAdvice: true });
