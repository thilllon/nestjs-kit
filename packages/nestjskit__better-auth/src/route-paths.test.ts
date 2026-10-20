import {
  RequestMethod,
  VERSION_NEUTRAL,
  type VersioningOptions,
  VersioningType,
} from "@nestjs/common";
import { ApplicationConfig } from "@nestjs/core";
// Tests may reach Nest internals: they pin the package's rules to the installed Nest router.
import { mapToExcludeRoute } from "@nestjs/core/middleware/utils.js";
import { RoutePathFactory } from "@nestjs/core/router/route-path-factory.js";
import { describe, expect, it } from "vitest";
import {
  composeRoutePaths,
  type RoutePathInput,
  type RouteVersion,
} from "./route-paths.js";

const controllerPaths = ["", "/", "users", "/users/", "{/:tenant}", "au:tail"];
const methodPaths = ["", "/", ":id", "/profile/", "{/:id}", "*rest"];
const modulePaths = [undefined, "admin", "/admin/"];
const globalPrefixes = [undefined, "", "v1", "/api/", "api/"];
const versions: (RouteVersion | undefined)[] = [
  undefined,
  "",
  "1",
  VERSION_NEUTRAL,
  ["1", "2"],
  [VERSION_NEUTRAL, "2"],
  [],
];
const versioning: (VersioningOptions | undefined)[] = [
  undefined,
  { type: VersioningType.URI },
  { type: VersioningType.URI, prefix: false },
  { type: VersioningType.URI, prefix: "version-" },
  { type: VersioningType.HEADER, header: "x-api-version" },
];
const methods = [undefined, RequestMethod.GET, RequestMethod.POST];
const exclusions = [
  undefined,
  mapToExcludeRoute([
    "health",
    { path: "users/:id", method: RequestMethod.GET },
    { path: "admin/users/*rest", method: RequestMethod.POST },
    { path: "{/:tenant}/profile", method: RequestMethod.ALL },
    // Nest also reads -1 as every method.
    { path: "users/users/*rest", method: -1 as RequestMethod },
  ]),
];

function describeCase(
  input: RoutePathInput,
  method: RequestMethod | undefined,
  exclude: unknown,
): string {
  const version = (value: RouteVersion | undefined) =>
    typeof value === "object" ? value.map(String) : String(value);
  return JSON.stringify({
    ...input,
    controllerVersion: version(input.controllerVersion),
    methodVersion: version(input.methodVersion),
    method,
    exclude: Boolean(exclude),
  });
}

function nestPaths(
  input: RoutePathInput,
  method: RequestMethod | undefined,
  exclude: ReturnType<typeof mapToExcludeRoute> | undefined,
): string[] {
  const config = new ApplicationConfig();
  if (exclude) {
    config.setGlobalPrefixOptions({ exclude });
  }
  return new RoutePathFactory(config).create(
    input as Parameters<RoutePathFactory["create"]>[0],
    method,
  );
}

describe("composeRoutePaths", () => {
  it("composes the paths Nest's router registers for every combination of path inputs", () => {
    const mismatches: string[] = [];
    for (const ctrlPath of controllerPaths) {
      for (const methodPath of methodPaths) {
        for (const modulePath of modulePaths) {
          for (const globalPrefix of globalPrefixes) {
            for (const exclude of exclusions) {
              const input = { ctrlPath, methodPath, modulePath, globalPrefix };
              const expected = nestPaths(input, RequestMethod.GET, exclude);
              const actual = composeRoutePaths(
                input,
                RequestMethod.GET,
                exclude,
              );
              if (JSON.stringify(actual) !== JSON.stringify(expected)) {
                mismatches.push(
                  `${describeCase(input, RequestMethod.GET, exclude)}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`,
                );
              }
            }
          }
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("applies Nest's version segments and global-prefix exclusions per request method", () => {
    const mismatches: string[] = [];
    for (const ctrlPath of ["users", "admin", "{/:tenant}"]) {
      for (const methodPath of [":id", "users/*rest", "profile"]) {
        for (const globalPrefix of globalPrefixes) {
          for (const controllerVersion of versions) {
            for (const methodVersion of versions) {
              for (const versioningOptions of versioning) {
                for (const method of methods) {
                  for (const exclude of exclusions) {
                    const input: RoutePathInput = {
                      ctrlPath,
                      methodPath,
                      globalPrefix,
                      controllerVersion,
                      methodVersion,
                      versioningOptions,
                    };
                    const expected = nestPaths(input, method, exclude);
                    const actual = composeRoutePaths(input, method, exclude);
                    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
                      mismatches.push(
                        `${describeCase(input, method, exclude)}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`,
                      );
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("keeps an excluded URI-versioned route outside the global prefix", () => {
    expect(
      composeRoutePaths(
        {
          ctrlPath: "users",
          methodPath: ":id",
          globalPrefix: "api",
          controllerVersion: ["1", VERSION_NEUTRAL],
          versioningOptions: { type: VersioningType.URI },
        },
        RequestMethod.GET,
        mapToExcludeRoute([{ path: "users/:id", method: RequestMethod.GET }]),
      ),
    ).toEqual(["/v1/users/:id", "/users/:id"]);
  });
});
