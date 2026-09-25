import type { InvocationLineage } from "./auth-contracts.js";

const OPERATIONS = Symbol.for("nestjs-slightly-better-auth:graphql-operations");
interface Path {
  readonly key: string | number;
  readonly prev?: Path;
  readonly typename?: string;
}
export interface GraphInfo {
  readonly operation: object & { operation?: string };
  readonly path: Path;
}
export function record(
  value: unknown,
): Record<PropertyKey, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<PropertyKey, unknown>)
    : undefined;
}
/** Apollo reference resolvers omit the argument object; parameter readers see the original array. */
export function graphqlArgs(args: readonly unknown[]) {
  const reference = args.length === 3;
  return {
    root: record(args[0]),
    args: reference ? undefined : record(args[1]),
    context: record(args[reference ? 1 : 2]) ?? args,
    info: record(args[reference ? 2 : 3]) as unknown as GraphInfo | undefined,
  };
}
interface Operation {
  id: number;
  references: Set<string>;
}
function operationState(carrier: object, operation: object): Operation {
  let operations = Reflect.get(carrier, OPERATIONS) as
    | Map<object, Operation>
    | undefined;
  if (!operations) {
    operations = new Map();
    Object.defineProperty(carrier, OPERATIONS, { value: operations });
  }
  let state = operations.get(operation);
  if (state === undefined) {
    state = { id: operations.size + 1, references: new Set() };
    operations.set(operation, state);
  }
  return state;
}
function keys(path: Path | undefined): (string | number)[] {
  return path ? [...keys(path.prev), path.key] : [];
}
function position(id: number, path: Path | undefined): string {
  return `${id}:${JSON.stringify(keys(path))}`;
}
export function graphqlInvocation(
  args: readonly unknown[],
  reference = false,
): object {
  const normalized = graphqlArgs(args);
  return (reference ? normalized.root : normalized.info) ?? args;
}
export function graphqlLineage(
  args: readonly unknown[],
  reference = false,
): InvocationLineage {
  const normalized = graphqlArgs(args);
  const carrier = normalized.context;
  const state = operationState(carrier, normalized.info?.operation ?? carrier);
  const { id } = state;
  if (reference) {
    state.references.add(JSON.stringify(keys(normalized.info?.path)));
  }
  return {
    carrier,
    position: reference
      ? `${id}:_entities#${String(normalized.root?.__typename ?? "")}`
      : position(id, normalized.info?.path),
    *enclosing(currentArgs) {
      const current = graphqlArgs(currentArgs);
      const operation = operationState(
        current.context,
        current.info?.operation ?? current.context,
      );
      const path = current.info?.path;
      for (
        let child = path, parent = path?.prev;
        parent;
        child = parent, parent = parent.prev
      ) {
        // The child path supplies the concrete entity type below the list index.
        if (
          typeof parent.key === "number" &&
          parent.prev &&
          (parent.prev.key === "_entities" ||
            operation.references.has(JSON.stringify(keys(parent.prev))))
        ) {
          yield `${operation.id}:_entities#${child?.typename ?? String(current.root?.__typename ?? "")}`;
        }
        yield position(operation.id, parent);
      }
    },
  };
}
