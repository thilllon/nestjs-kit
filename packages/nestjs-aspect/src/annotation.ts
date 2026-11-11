import "reflect-metadata";
import type { ReflectableDecorator } from "@nestjs/core";
import { AspectConfigurationError } from "./errors";
import { RESERVED_MEMBERS } from "./pointcut";
import type {
  Annotation,
  AnnotationLike,
  AnnotationMatch,
  AnnotationRecord,
  AnyFunction,
  AsyncMethod,
  Class,
  MethodRef,
} from "./types";
import { constructorChain } from "./util";

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
   * A member that carries the annotation must be advised by an advisor
   * whose pointcut refers to the annotation, or whose pointcut has a
   * caller-supplied matcher. Otherwise the bootstrap fails and every call of
   * the member raises `AspectConfigurationError`.
   */
  requiresAdvice?: boolean;
  /**
   * The annotation applies only to methods that return a promise. Without
   * a contract type argument, `createAnnotation(name, { async: true })` gives
   * the annotation the method contract `AsyncMethod`. An explicit contract
   * is kept as given; the type of the options does not check it.
   *
   * Applying the annotation throws `AspectConfigurationError` when the member
   * is an accessor, or when its emitted `design:returntype` metadata is a
   * class other than `Promise`, a subclass of it or `Object`. Applied to a
   * class, the annotation checks the methods the class declares and inherits
   * that are default join points and have emitted `design:returntype`
   * metadata. The compiler emits it only for decorated members, so an
   * undecorated method of the class is not checked.
   */
  async?: boolean;
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

function nestKey(annotation: AnnotationLike<any>): unknown {
  const key =
    typeof annotation === "function"
      ? (annotation as { KEY?: unknown }).KEY
      : undefined;
  if (key === undefined) {
    throw new AspectConfigurationError(
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
 * Creates a typed annotation usable on methods and classes, and on accessors
 * when it declares no method contract. With `{ async: true }` and no type
 * arguments, the annotation takes no value, has the method contract
 * `AsyncMethod` and the name literal `N`.
 */
export function createAnnotation<N extends string, V = void>(
  name: N,
  options: AnnotationOptions & { async: true },
): Annotation<V, AsyncMethod, N>;
/**
 * Creates a typed annotation usable on methods and classes, and on accessors
 * when it declares no method contract. `V` is the value type and `F` the
 * method contract. With `async: true`, `F` is kept as given; the check of
 * the emitted return type rejects a synchronous method when it is applied.
 */
export function createAnnotation<
  N extends string,
  V = void,
  F extends AnyFunction = AnyFunction,
>(name: N, options?: AnnotationOptions): Annotation<V, F, N>;
// Throws `AspectConfigurationError` for an empty name.
export function createAnnotation(
  name: string,
  options: AnnotationOptions = {},
): Annotation<unknown, AnyFunction, string> {
  if (typeof name !== "string" || name.length === 0) {
    throw new AspectConfigurationError("An annotation needs a non-empty name");
  }
  const requiresAdvice = options.requiresAdvice === true;
  const async = options.async === true;
  const annotation = (...value: unknown[]) => {
    const record: AnnotationRecord = Object.freeze({
      name,
      value: value[0],
      requiresAdvice,
    });
    return (
      target: object,
      key?: string | symbol,
      descriptor?: PropertyDescriptor,
    ): void => {
      if (async) {
        checkAsyncContract(name, target, key, descriptor);
      }
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
    async: { value: async, enumerable: true },
    [ANNOTATION_MARKER]: { value: true },
  });
  return annotation as unknown as Annotation<unknown, AnyFunction, string>;
}

/**
 * The emitted return type of a method when it shows that the method does not
 * return a promise. A missing or `undefined` value (no annotation, `void`),
 * `Object` (interfaces, unions, `any`) and `Promise` with its subclasses say
 * nothing against it.
 */
function nonPromiseReturnType(
  holder: object,
  key: string | symbol,
): AnyFunction | undefined {
  const returnType: unknown = Reflect.getOwnMetadata(
    "design:returntype",
    holder,
    key,
  );
  if (
    typeof returnType !== "function" ||
    returnType === Object ||
    returnType === Promise ||
    returnType.prototype instanceof Promise
  ) {
    return undefined;
  }
  return returnType as AnyFunction;
}

function memberLabel(target: object, key: string | symbol): string {
  const type =
    typeof target === "function" ? target : (target.constructor as Class);
  return `${type.name}.${String(key)}`;
}

/**
 * Rejects the application of an `async` annotation to an accessor or to a
 * method whose emitted return type is no promise. On a class, checks every
 * method the class declares or inherits that is a default join point and has
 * emitted return type metadata, which the compiler emits for decorated
 * members only.
 */
function checkAsyncContract(
  name: string,
  target: object,
  key: string | symbol | undefined,
  descriptor: PropertyDescriptor | undefined,
): void {
  const decorator = `@${name}`;
  if (key === undefined) {
    const violations = asyncViolationsOfClass(target as Class);
    if (violations.length > 0) {
      throw new AspectConfigurationError(
        `${decorator} on ${(target as Class).name} requires methods that return a promise: ${violations.join(", ")}`,
      );
    }
    return;
  }
  const member = descriptor ?? Object.getOwnPropertyDescriptor(target, key);
  if (typeof member?.value !== "function") {
    throw new AspectConfigurationError(
      `${decorator} applies to methods that return a promise; ${memberLabel(target, key)} is no method`,
    );
  }
  const returnType = nonPromiseReturnType(target, key);
  if (returnType) {
    throw new AspectConfigurationError(
      `${decorator} requires a method that returns a promise; ${memberLabel(target, key)} returns ${returnType.name}`,
    );
  }
}

function asyncViolationsOfClass(type: Class): string[] {
  const seen = new Set<string | symbol>();
  const violations: string[] = [];
  for (
    let prototype: object | null = type.prototype;
    prototype && prototype !== Object.prototype;
    prototype = Object.getPrototypeOf(prototype)
  ) {
    for (const key of Reflect.ownKeys(prototype)) {
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const member = Object.getOwnPropertyDescriptor(prototype, key);
      if (RESERVED_MEMBERS.has(key) || typeof member?.value !== "function") {
        continue;
      }
      const returnType = nonPromiseReturnType(prototype, key);
      if (returnType) {
        violations.push(
          `${memberLabel(prototype, key)} returns ${returnType.name}`,
        );
      }
    }
  }
  return violations;
}

/** True for a value created by `createAnnotation` (of any copy of the package). */
export function isAnnotation(
  value: unknown,
): value is Annotation<unknown, AnyFunction, string> {
  return (
    typeof value === "function" &&
    (value as unknown as Record<symbol, unknown>)[ANNOTATION_MARKER] === true
  );
}

/**
 * Looks an annotation up for a join point: the method, then the declaring
 * class, then the target class; the first one found wins. Each class step
 * includes the annotations the class inherits, so for an inherited method an
 * annotation on a superclass of the declaring class wins over one on the
 * target class.
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
