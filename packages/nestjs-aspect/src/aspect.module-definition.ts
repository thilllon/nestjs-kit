import { ConfigurableModuleBuilder } from "@nestjs/common";
import type {
  AdviceAdapter,
  Class,
  ClassFilter,
  ReturnValueAdapter,
} from "./types";

/** Logger level of the weaving report. */
export type AspectReportLevel = "verbose" | "debug" | "log";

export interface AspectModuleOptions {
  /**
   * Adapters that let advice follow the settlement of an asynchronous result,
   * consulted in the given order before the built-in `promiseAdapter`.
   */
  returnValueAdapters?: readonly ReturnValueAdapter<any>[];
  /**
   * Adapters that turn the `advice` of an `@Advisor` into a
   * `MethodInterceptor`, which adds advice kinds. They are consulted in the
   * given order before the built-in adapters for advice compiled from an
   * aspect and for `MethodInterceptor` objects.
   */
  adviceAdapters?: readonly AdviceAdapter[];
  /**
   * Level at which the weaving report is logged when the application
   * initializes; `false` logs no report. Defaults to `"debug"`.
   */
  report?: AspectReportLevel | false;
  /**
   * When true, the bootstrap validations fail the initialization of the
   * application with `AspectConfigurationError`. When false, they are logged
   * as warnings and the calls they concern fail instead: a member that
   * requires advice no advisor supplies raises `AspectConfigurationError`,
   * and advice whose aspect or advisor has no usable instance raises
   * `AspectNotReadyError` or `AspectConfigurationError`. Advice that can
   * never run, as that of an aspect a factory provider supplies, fails the
   * initialization in both modes.
   *
   * The option also decides a call on an object that several live
   * applications in the process advise while nothing tells which of them it
   * belongs to: an object created with `new`, an object under construction,
   * or one object in the containers of several applications. When true for
   * any of those applications, the call raises `AspectUsageError`; when
   * false for all of them, the most recently created one advises the object
   * and logs a warning once per class. Instances a container creates,
   * request-scoped and transient ones included, always belong to the
   * application of that container.
   *
   * Defaults to true.
   */
  strict?: boolean;
  /**
   * Classes that are never woven: a class excludes itself and its subclasses,
   * a class filter excludes the classes it matches.
   */
  exclude?: readonly (Class | ClassFilter)[];
}

export const {
  ConfigurableModuleClass,
  MODULE_OPTIONS_TOKEN,
  OPTIONS_TYPE,
  ASYNC_OPTIONS_TYPE,
} = new ConfigurableModuleBuilder<AspectModuleOptions>()
  .setClassMethodName("forRoot")
  .build();

/** Token of the application's `AspectWeaver`. */
export const ASPECT_WEAVER: unique symbol = Symbol("ASPECT_WEAVER");

/** Token of the provider that validates the scope of the weaver. */
export const ASPECT_WEAVER_GUARD: unique symbol = Symbol("ASPECT_WEAVER_GUARD");
