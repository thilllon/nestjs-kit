import {
  RequestMethod,
  VERSION_NEUTRAL,
  type VersioningOptions,
  VersioningType,
} from "@nestjs/common";

/** A `@Controller({ version })` or `@Version()` value. */
export type RouteVersion =
  | string
  | typeof VERSION_NEUTRAL
  | readonly (string | typeof VERSION_NEUTRAL)[];

/** The inputs from which Nest composes the paths it registers for one handler path. */
export interface RoutePathInput {
  readonly ctrlPath?: string;
  readonly methodPath?: string;
  /** The `RouterModule` path of the controller's module. */
  readonly modulePath?: string;
  readonly globalPrefix?: string;
  readonly controllerVersion?: RouteVersion;
  readonly methodVersion?: RouteVersion;
  readonly versioningOptions?: VersioningOptions;
}

/**
 * An entry of `ApplicationConfig.getGlobalPrefixOptions().exclude`: `setGlobalPrefix()` compiles
 * each excluded route to a `pathRegex`, so exclusion matching needs no path compiler here.
 */
export interface GlobalPrefixExclusion {
  readonly pathRegex: RegExp;
  /** A `RequestMethod`; Nest also reads `-1` as every method. */
  readonly requestMethod: number;
}

function addLeadingSlash(path: unknown): string {
  if (typeof path !== "string" || path === "") {
    return "";
  }
  // A leading `{/…}` group is optional, so Nest leaves its slash inside the group.
  return path.startsWith("/") || path.startsWith("{/") ? path : `/${path}`;
}

function stripEndSlash(path: string): string {
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

function versionPrefix(options: VersioningOptions): string {
  if (options.type === VersioningType.URI) {
    if (options.prefix === false) {
      return "";
    }
    if (options.prefix !== undefined) {
      return options.prefix;
    }
  }
  return "v";
}

function append(paths: readonly string[], fragment?: string): string[] {
  return fragment
    ? paths.map((path) => stripEndSlash(path) + addLeadingSlash(fragment))
    : [...paths];
}

function withoutVersionPrefix(
  path: string,
  version: RouteVersion,
  options: VersioningOptions,
): string {
  if (typeof version !== "string") {
    let stripped = path;
    for (const value of version as readonly unknown[]) {
      if (typeof value === "string") {
        stripped = withoutVersionPrefix(stripped, value, options);
      }
    }
    return stripped;
  }
  const prefix = `/${versionPrefix(options)}${version}`;
  return path.startsWith(prefix) ? path.replace(prefix, "") : path;
}

/**
 * Composes the paths Nest registers for a handler path, with the rules of Nest's router: URI
 * version segments, then the module, controller and handler paths, then the global prefix
 * unless an exclusion matches the method and the unversioned path. `@nestjs/core` does not
 * export its `RoutePathFactory`, so a test compares this function with that class.
 */
export function composeRoutePaths(
  input: RoutePathInput,
  requestMethod: RequestMethod | undefined,
  exclusions: readonly GlobalPrefixExclusion[] | undefined,
): string[] {
  // Nest gives the handler version precedence with `||`, so an empty handler version falls back.
  const version = input.methodVersion || input.controllerVersion;
  const options = input.versioningOptions;
  let paths = [""];
  if (version && options?.type === VersioningType.URI) {
    const prefix = versionPrefix(options);
    paths = (typeof version === "object" ? version : [version]).map((value) =>
      value === VERSION_NEUTRAL ? "" : `/${prefix}${value as string}`,
    );
  }
  paths = append(paths, input.modulePath);
  paths = append(paths, input.ctrlPath);
  paths = append(paths, input.methodPath);
  const globalPrefix = input.globalPrefix;
  if (globalPrefix) {
    const excluded = (path: string): boolean => {
      if (requestMethod === undefined || !Array.isArray(exclusions)) {
        return false;
      }
      const candidate = addLeadingSlash(
        version &&
          version !== VERSION_NEUTRAL &&
          options?.type === VersioningType.URI
          ? withoutVersionPrefix(path, version, options)
          : path,
      );
      return exclusions.some(
        (route) =>
          (route.requestMethod === RequestMethod.ALL ||
            route.requestMethod === -1 ||
            route.requestMethod === requestMethod) &&
          route.pathRegex.exec(candidate) !== null,
      );
    };
    paths = paths.map((path) =>
      excluded(path) ? path : stripEndSlash(globalPrefix) + path,
    );
  }
  return paths
    .map((path) => addLeadingSlash(path || "/"))
    .map((path) => (path === "/" ? path : stripEndSlash(path)));
}
