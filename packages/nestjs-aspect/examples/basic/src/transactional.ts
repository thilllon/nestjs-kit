import { createAnnotation } from "nestjs-aspect";

/**
 * Marks a method that `TransactionAspect` runs in a database transaction.
 * It applies only to methods that return a promise, and the application
 * fails to start when no advisor whose pointcut refers to the annotation
 * advises a method that carries it.
 */
export const Transactional = createAnnotation<
  "Transactional",
  void,
  (...args: any[]) => Promise<unknown>
>("Transactional", { requiresAdvice: true });
