import "reflect-metadata";
import type { ReflectableDecorator } from "@nestjs/core";
import { AopConfigurationError } from "./errors";
import type {
  Annotation,
  AnnotationLike,
  AnnotationMatch,
  AnnotationRecord,
  Class,
  Fn,
  MethodRef,
} from "./types";

/**
 * Reflect metadata key of the annotations applied to one target. The value is
 * a `ReadonlyMap<string, AnnotationRecord>` keyed by annotation name.
 *
 * - Method and accessor annotations are own metadata of
 *   `(DeclaringClass.prototype, memberName)`. They are not inherited: an
 *   override without the annotation does not carry it.
 * - Class annotations are own metadata of the class constructor. A lookup
 *   walks the constructor chain, so subclasses inherit them.
 *
 * A decorator replaces the stored map with a copy instead of mutating it.
 * The key is registered with `Symbol.for`, so two copies of the package read
 * each other's annotations.
 */
export const ANNOTATIONS_METADATA: unique symbol = Symbol.for(
  "nestjs-aspect:annotations",
);

export interface AnnotationOptions {
  /**
   * Bootstrap fails when a method carries the annotation and no advisor
   * matches it.
   */
  requiresAdvice?: boolean;
}

/** Own property that marks a function created by `createAnnotation`. */
const ANNOTATION_MARKER: unique symbol = Symbol.for("nestjs-aspect:annotation");

type AnnotationRecords = ReadonlyMap<string, AnnotationRecord>;

/** A lookup hit; the wrapper tells an absent annotation from an `undefined` value. */
interface Found {
  readonly value: unknown;
}

function ownRecords(
  target: object,
  key?: string | symbol,
): AnnotationRecords | undefined {
  return key === undefined
    ? Reflect.getOwnMetadata(ANNOTATIONS_METADATA, target)
    : Reflect.getOwnMetadata(ANNOTATIONS_METADATA, target, key);
}

function memberRecords(method: MethodRef): AnnotationRecords | undefined {
  return ownRecords(method.declaringType.prototype, method.name);
}

/** The class and its superclasses, nearest first. */
function* constructorChain(type: Class): Generator<Class> {
  for (
    let current: unknown = type;
    typeof current === "function" && current !== Function.prototype;
    current = Object.getPrototypeOf(current)
  ) {
    yield current as Class;
  }
}

function nestKey(annotation: AnnotationLike<any>): unknown {
  const key =
    typeof annotation === "function"
      ? (annotation as { KEY?: unknown }).KEY
      : undefined;
  if (key === undefined) {
    throw new AopConfigurationError(
      "Expected an annotation created by createAnnotation() or Reflector.createDecorator()",
    );
  }
  return key;
}

function findOnMember(
  annotation: AnnotationLike<any>,
  method: MethodRef,
): Found | undefined {
  if (isAnnotation(annotation)) {
    return memberRecords(method)?.get(annotation.annotationName);
  }
  const key = nestKey(annotation);
  return Reflect.hasOwnMetadata(key, method.original)
    ? { value: Reflect.getOwnMetadata(key, method.original) }
    : undefined;
}

function findOnClass(
  annotation: AnnotationLike<any>,
  type: Class,
): Found | undefined {
  if (isAnnotation(annotation)) {
    for (const current of constructorChain(type)) {
      const record = ownRecords(current)?.get(annotation.annotationName);
      if (record) {
        return record;
      }
    }
    return undefined;
  }
  const key = nestKey(annotation);
  for (const current of constructorChain(type)) {
    if (Reflect.hasOwnMetadata(key, current)) {
      return { value: Reflect.getOwnMetadata(key, current) };
    }
  }
  return undefined;
}

/**
 * Creates a typed annotation usable on methods, accessors and classes.
 * Throws `AopConfigurationError` for an empty name.
 */
export function createAnnotation<N extends string, V = void, F extends Fn = Fn>(
  name: N,
  options: AnnotationOptions = {},
): Annotation<V, F, N> {
  if (typeof name !== "string" || name.length === 0) {
    throw new AopConfigurationError("An annotation needs a non-empty name");
  }
  const requiresAdvice = options.requiresAdvice === true;
  const annotation = (...value: unknown[]) => {
    const record: AnnotationRecord = Object.freeze({
      name,
      value: value[0],
      requiresAdvice,
    });
    return (target: object, key?: string | symbol): void => {
      const records = new Map(ownRecords(target, key));
      records.set(name, record);
      if (key === undefined) {
        Reflect.defineMetadata(ANNOTATIONS_METADATA, records, target);
      } else {
        Reflect.defineMetadata(ANNOTATIONS_METADATA, records, target, key);
      }
    };
  };
  Object.defineProperties(annotation, {
    annotationName: { value: name, enumerable: true },
    requiresAdvice: { value: requiresAdvice, enumerable: true },
    [ANNOTATION_MARKER]: { value: true },
  });
  return annotation as unknown as Annotation<V, F, N>;
}

/** True for a value created by `createAnnotation` (of any copy of the package). */
export function isAnnotation(
  value: unknown,
): value is Annotation<unknown, Fn, string> {
  return (
    typeof value === "function" &&
    (value as unknown as Record<symbol, unknown>)[ANNOTATION_MARKER] === true
  );
}

/**
 * Looks an annotation up for a join point: the method, then the declaring
 * class, then the target class; the first one found wins.
 *
 * A Nest `Reflector.createDecorator` decorator is read from its `KEY`
 * metadata: on `method.original` for the method, on the class constructors
 * for the classes.
 */
export function findAnnotation<V>(
  annotation: Annotation<V, any, any>,
  method: MethodRef,
): AnnotationMatch<V> | undefined;
export function findAnnotation<V>(
  // Spelled without the `NestAnnotation` alias, through which `V` is not inferred.
  annotation: ReflectableDecorator<any, V>,
  method: MethodRef,
): AnnotationMatch<V> | undefined;
export function findAnnotation<V>(
  annotation: AnnotationLike<V>,
  method: MethodRef,
): AnnotationMatch<V> | undefined;
export function findAnnotation<V>(
  annotation: AnnotationLike<V>,
  method: MethodRef,
): AnnotationMatch<V> | undefined {
  const onMember = findOnMember(annotation, method);
  if (onMember) {
    return { value: onMember.value as V, source: "method" };
  }
  const onDeclaringType = findOnClass(annotation, method.declaringType);
  if (onDeclaringType) {
    return { value: onDeclaringType.value as V, source: "declaringType" };
  }
  const onTargetType = findOnClass(annotation, method.targetType);
  if (onTargetType) {
    return { value: onTargetType.value as V, source: "targetType" };
  }
  return undefined;
}

/** True when the member itself carries the annotation (`@annotation`). */
export function hasMethodAnnotation(
  annotation: AnnotationLike<any>,
  method: MethodRef,
): boolean {
  return findOnMember(annotation, method) !== undefined;
}

/**
 * True when the class or one of its superclasses carries the annotation
 * (`@within` with the declaring type, `@target` with the target type).
 */
export function hasClassAnnotation(
  annotation: AnnotationLike<any>,
  type: Class,
): boolean {
  return findOnClass(annotation, type) !== undefined;
}

/**
 * Records of the annotations that apply to a join point, one per annotation
 * name, resolved in the lookup order of `findAnnotation`. Nest decorators are
 * not listed.
 */
export function listAnnotations(
  method: MethodRef,
): readonly AnnotationRecord[] {
  const resolved = new Map<string, AnnotationRecord>();
  const sources = [
    memberRecords(method),
    ...[...constructorChain(method.declaringType)].map((type) =>
      ownRecords(type),
    ),
    ...[...constructorChain(method.targetType)].map((type) => ownRecords(type)),
  ];
  for (const records of sources) {
    for (const record of records?.values() ?? []) {
      if (!resolved.has(record.name)) {
        resolved.set(record.name, record);
      }
    }
  }
  return [...resolved.values()];
}

/**
 * Names of the `requiresAdvice` annotations that apply to a join point. The
 * weaver reports a join point for which this is not empty and no advisor
 * matched.
 */
export function requiredAdviceAnnotations(
  method: MethodRef,
): readonly string[] {
  return listAnnotations(method)
    .filter((record) => record.requiresAdvice)
    .map((record) => record.name);
}
