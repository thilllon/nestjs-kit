// The `perTarget` and `perClass` instantiation models: aspect instances that
// the weaver creates during a call, outside the container.

import "reflect-metadata";
import { type InjectionToken, Scope } from "@nestjs/common";
import type { ModuleRef } from "@nestjs/core";
import { AspectConfigurationError } from "./errors";
import type { AspectInstantiation, Class } from "./types";
import { isObject } from "./util";

// Metadata keys under which TypeScript and the Nest injection decorators
// record the dependencies of a class.
const PARAMETER_TYPES = "design:paramtypes";
const DECLARED_PARAMETERS = "self:paramtypes";
const OPTIONAL_PARAMETERS = "optional:paramtypes";
const DECLARED_PROPERTIES = "self:properties_metadata";
const OPTIONAL_PROPERTIES = "optional:properties_metadata";

interface Dependency {
  /** `undefined` when the metadata names no token, as in a circular import. */
  readonly token: InjectionToken | undefined;
  readonly optional: boolean;
  /** `"constructor parameter 0"` or `"property clock"`. */
  readonly position: string;
}

interface PropertyDependency extends Dependency {
  readonly key: string | symbol;
}

/** The token of an `@Inject()` argument or a parameter type. */
function tokenOf(declared: unknown): InjectionToken | undefined {
  const token =
    isObject(declared) && typeof declared.forwardRef === "function"
      ? (declared.forwardRef() as unknown)
      : declared;
  return token === undefined || token === null
    ? undefined
    : (token as InjectionToken);
}

/** Constructor dependencies of a class, as the Nest injector reads them. */
function parameterDependencies(type: Class): Dependency[] {
  const tokens: unknown[] = [
    ...((Reflect.getMetadata(PARAMETER_TYPES, type) as unknown[]) ?? []),
  ];
  const declared: { index: number; param: unknown }[] =
    Reflect.getMetadata(DECLARED_PARAMETERS, type) ?? [];
  for (const { index, param } of declared) {
    tokens[index] = param;
  }
  const optional: number[] =
    Reflect.getMetadata(OPTIONAL_PARAMETERS, type) ?? [];
  return tokens.map((token, index) => ({
    token: tokenOf(token),
    optional: optional.includes(index),
    position: `constructor parameter ${index}`,
  }));
}

/** Dependencies a class declares with `@Inject()` on properties. */
function propertyDependencies(type: Class): PropertyDependency[] {
  const declared: { key: string | symbol; type: unknown }[] =
    Reflect.getMetadata(DECLARED_PROPERTIES, type) ?? [];
  const optional: (string | symbol)[] =
    Reflect.getMetadata(OPTIONAL_PROPERTIES, type) ?? [];
  return declared.map(({ key, type: token }) => ({
    key,
    token: tokenOf(token),
    optional: optional.includes(key),
    position: `property ${String(key)}`,
  }));
}

/** The facts of a Nest instance wrapper that tell the scope of a provider. */
interface ProviderWrapper {
  readonly isTransient: boolean;
  isDependencyTreeStatic(): boolean;
}

/** The module that registers an aspect, for the dependencies of its instances. */
export interface AspectHost {
  readonly moduleRef: ModuleRef;
  /** The provider that the module itself registers under `token`. */
  ownProvider(token: InjectionToken): ProviderWrapper | undefined;
}

/**
 * The scope of the provider that supplies `token` to the aspects of `host`:
 * the provider of the module itself, as the container injects it into the
 * provider instance of the aspect, otherwise the one that
 * `ModuleRef.introspect` selects among the other modules. Throws when no
 * provider of the application supplies the token.
 */
function scopeOf(token: InjectionToken, host: AspectHost): Scope {
  const own = host.ownProvider(token);
  if (!own) {
    return host.moduleRef.introspect(token as string).scope;
  }
  if (!own.isDependencyTreeStatic()) {
    return Scope.REQUEST;
  }
  return own.isTransient ? Scope.TRANSIENT : Scope.DEFAULT;
}

function describeToken(dependency: Dependency): string {
  const { token, position } = dependency;
  if (token === undefined) {
    return `its ${position}`;
  }
  return typeof token === "function" && token.name ? token.name : String(token);
}

/**
 * Why `dependency` of an aspect cannot be supplied during a call, or
 * `undefined` when it can: the dependency is a singleton, or it is optional
 * and no provider of the application supplies it.
 */
function dependencyProblem(
  dependency: Dependency,
  host: AspectHost,
): string | undefined {
  const { token, optional } = dependency;
  let scope: Scope | undefined;
  try {
    scope = token === undefined ? undefined : scopeOf(token, host);
  } catch {
    // No provider of the application supplies the token.
  }
  if (scope === undefined) {
    return optional
      ? undefined
      : `depends on ${describeToken(dependency)}, which no provider of the application supplies`;
  }
  return scope === Scope.DEFAULT
    ? undefined
    : `depends on ${describeToken(dependency)}, which is request-scoped or transient`;
}

const RULE =
  "An instance of the aspect is created during a call, so every dependency must be a singleton provider.";

/**
 * The dependencies of a `perTarget` or `perClass` aspect that cannot be
 * supplied during a call, one message each; for the bootstrap validation.
 */
export function aspectDependencyProblems(
  type: Class,
  model: AspectInstantiation,
  host: AspectHost,
): string[] {
  return [...parameterDependencies(type), ...propertyDependencies(type)]
    .map((dependency) => dependencyProblem(dependency, host))
    .filter((problem) => problem !== undefined)
    .map((problem) => `The ${model} aspect ${type.name} ${problem}. ${RULE}`);
}

/**
 * Creates an instance of a `perTarget` or `perClass` aspect synchronously.
 * Its constructor and property dependencies are singleton providers: the one
 * the module of the aspect registers under the token, otherwise the one
 * `ModuleRef.get(token, { strict: false })` returns. An optional dependency
 * that no provider supplies is `undefined`.
 *
 * Throws `AspectConfigurationError` for a dependency that is request-scoped,
 * transient or missing.
 */
export function createAspectInstance(
  type: Class,
  model: AspectInstantiation,
  host: AspectHost,
): object {
  const resolve = (dependency: Dependency): unknown => {
    const problem = dependencyProblem(dependency, host);
    if (problem !== undefined) {
      throw new AspectConfigurationError(
        `The ${model} aspect ${type.name} ${problem}. ${RULE}`,
      );
    }
    try {
      const token = dependency.token as string;
      return host.moduleRef.get(token, {
        strict: host.ownProvider(token) !== undefined,
      });
    } catch (error) {
      if (dependency.optional) {
        return undefined;
      }
      throw error;
    }
  };
  const instance = new (type as new (...args: unknown[]) => object)(
    ...parameterDependencies(type).map(resolve),
  );
  for (const dependency of propertyDependencies(type)) {
    const value = resolve(dependency);
    if (value !== undefined) {
      (instance as Record<string | symbol, unknown>)[dependency.key] = value;
    }
  }
  return instance;
}
