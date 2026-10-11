// Text of the weaving report and of the weaver's diagnostics.

import type { AdvisorDescriptor, AdvisorSource, MethodRef } from "./types";

const KIND_PREFIX = { method: "", getter: "get ", setter: "set " } as const;

/** `"UserService.findById"`, `"UserService.get name"`. */
export function describeMember(method: MethodRef): string {
  return `${method.targetType.name}.${KIND_PREFIX[method.kind]}${String(method.name)}`;
}

/** `"ResilienceAspect.retry"`, or the class name of an `@Advisor`. */
export function describeSource(source: AdvisorSource): string {
  return source.methodName === undefined
    ? source.type.name
    : `${source.type.name}.${String(source.methodName)}`;
}

/** `"order 10"`, or `"no order"` for the lowest precedence. */
export function describeOrder(order: number | undefined): string {
  return order === undefined ? "no order" : `order ${order}`;
}

/**
 * One line of the weaving report:
 * `"UserService.findById <- ResilienceAspect.retry (around, order 10)"`.
 * An `@Advisor` has no advice kind.
 */
export function reportLine(
  method: MethodRef,
  advisor: AdvisorDescriptor,
): string {
  const { source, order } = advisor;
  const details = [source.kind, describeOrder(order)].filter(
    (detail) => detail !== undefined,
  );
  return `${describeMember(method)} <- ${describeSource(source)} (${details.join(", ")})`;
}
