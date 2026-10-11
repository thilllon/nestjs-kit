// Slice A. Exported signatures are frozen; the bodies are the slice's work.

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

/**
 * Creates a typed annotation usable on methods, accessors and classes.
 * Throws `AopConfigurationError` for an empty name.
 */
export function createAnnotation<N extends string, V = void, F extends Fn = Fn>(
  _name: N,
  _options?: AnnotationOptions,
): Annotation<V, F, N> {
  throw new Error("not implemented");
}

/** True for a value created by `createAnnotation` (of any copy of the package). */
export function isAnnotation(
  _value: unknown,
): _value is Annotation<unknown, Fn, string> {
  throw new Error("not implemented");
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
  _annotation: AnnotationLike<V>,
  _method: MethodRef,
): AnnotationMatch<V> | undefined {
  throw new Error("not implemented");
}

/** True when the member itself carries the annotation (`@annotation`). */
export function hasMethodAnnotation(
  _annotation: AnnotationLike,
  _method: MethodRef,
): boolean {
  throw new Error("not implemented");
}

/**
 * True when the class or one of its superclasses carries the annotation
 * (`@within` with the declaring type, `@target` with the target type).
 */
export function hasClassAnnotation(
  _annotation: AnnotationLike,
  _type: Class,
): boolean {
  throw new Error("not implemented");
}

/**
 * Records of the annotations that apply to a join point, one per annotation
 * name, resolved in the lookup order of `findAnnotation`. Nest decorators are
 * not listed.
 */
export function listAnnotations(
  _method: MethodRef,
): readonly AnnotationRecord[] {
  throw new Error("not implemented");
}

/**
 * Names of the `requiresAdvice` annotations that apply to a join point. The
 * weaver reports a join point for which this is not empty and no advisor
 * matched.
 */
export function requiredAdviceAnnotations(
  _method: MethodRef,
): readonly string[] {
  throw new Error("not implemented");
}
