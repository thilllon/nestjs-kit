import { ConfigurableModuleBuilder } from "@nestjs/common";
import type { Class, ClassFilter, ReturnValueAdapter } from "./types";

/** Logger level of the weaving report. */
export type AspectReportLevel = "verbose" | "debug" | "log";

export interface AspectModuleOptions {
  /**
   * Adapters that let advice follow the settlement of an asynchronous result,
   * consulted in the given order before the built-in `promiseAdapter`.
   */
  returnValueAdapters?: readonly ReturnValueAdapter<any>[];
  /**
   * Level at which the weaving report is logged when the application
   * initializes; `false` logs no report. Defaults to `"debug"`.
   */
  report?: AspectReportLevel | false;
  /**
   * When true, the bootstrap validations fail the initialization of the
   * application with `AspectConfigurationError`; when false, they are logged
   * as warnings. Defaults to true.
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
