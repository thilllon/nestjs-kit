import { Inject, Logger } from "@nestjs/common";
import { DiscoveryService, MetadataScanner } from "@nestjs/core";
import { readHookMetadata } from "./auth-decorators.js";
import type { AuthHookContext, DatabaseHookMethod } from "./auth-types.js";
import { BetterAuthConfigurationError } from "./auth-errors.js";
import type { DatabaseHookTarget } from "./auth-contracts.js";
import type { BridgeBinding, CompiledHook } from "./bridge-protocol.js";
import {
  isSingletonDependencyTree,
  type InstanceRegistry,
} from "./instance-registry.js";

export type HookTables = Pick<BridgeBinding, "before" | "after" | "database">;
export const DATABASE_TARGETS: readonly DatabaseHookTarget[] = [
  "user",
  "session",
  "account",
  "verification",
].flatMap((model) =>
  ["create", "update", "delete"].map(
    (operation) => `${model}.${operation}` as DatabaseHookTarget,
  ),
);
export function emptyHookTables(): HookTables {
  return {
    before: [],
    after: [],
    database: Object.fromEntries(
      DATABASE_TARGETS.map((target) => [target, { before: [], after: [] }]),
    ) as unknown as BridgeBinding["database"],
  };
}

function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(
        next[j - 1]! + 1,
        row[j]! + 1,
        row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    row = next;
  }
  return row[b.length]!;
}

export class HookBinder {
  private readonly logger = new Logger("BetterAuth");

  constructor(
    @Inject(DiscoveryService) private readonly discovery: DiscoveryService,
    @Inject(MetadataScanner) private readonly scanner: MetadataScanner,
  ) {}

  discover(
    registry: InstanceRegistry,
    issues: BetterAuthConfigurationError[],
  ): Map<string, HookTables> {
    const endpoint = new Map<
      string,
      { phase: "before" | "after"; order: number; hook: CompiledHook }[]
    >();
    const database = new Map<
      string,
      {
        phase: "before" | "after";
        target: DatabaseHookTarget;
        order: number;
        hook: DatabaseHookMethod<DatabaseHookTarget, "before" | "after">;
      }[]
    >();
    const registrations = new Set(
      registry.registrations().map((item) => item.name),
    );
    const discovered = new Map<unknown, string>();
    for (const wrapper of this.discovery.getProviders()) {
      if (
        wrapper.isAlias ||
        !wrapper.instance ||
        (typeof wrapper.instance !== "object" &&
          typeof wrapper.instance !== "function")
      ) {
        continue;
      }
      const instance = wrapper.instance as object;
      const prototype = Object.getPrototypeOf(instance) as object | null;
      if (!prototype) {
        continue;
      }
      const methods = new Set<string | symbol>(
        this.scanner.getAllMethodNames(instance),
      );
      for (
        let current: object | null = instance;
        current && current !== Object.prototype;
        current = Object.getPrototypeOf(current)
      ) {
        for (const key of Object.getOwnPropertySymbols(current)) {
          if (
            typeof Object.getOwnPropertyDescriptor(current, key)?.value ===
            "function"
          ) {
            methods.add(key);
          }
        }
      }
      let found = false;
      for (const method of methods) {
        const handler = Reflect.get(instance, method);
        if (typeof handler !== "function") {
          continue;
        }
        const metadata = readHookMetadata(handler);
        if (!metadata.hooks.length && !metadata.databaseHooks.length) {
          continue;
        }
        found = true;
        if (!isSingletonDependencyTree(wrapper)) {
          issues.push(
            new BetterAuthConfigurationError(
              "NON_SINGLETON_EXTENSION",
              `Hook provider '${wrapper.name}' is not a static singleton.`,
              "Remove request/transient dependencies from hook providers.",
            ),
          );
          continue;
        }
        for (const declaration of metadata.hooks) {
          const name = declaration.options.instance ?? "default";
          if (!registrations.has(name)) {
            issues.push(
              new BetterAuthConfigurationError(
                "UNKNOWN_INSTANCE",
                `Hook '${wrapper.name}.${String(method)}' names unknown instance '${name}'.`,
              ),
            );
            continue;
          }
          const entry = registry.list().find((value) => value.name === name);
          if (!entry) {
            continue;
          }
          const paths = Object.values(entry.instance.api).flatMap((api) =>
            typeof api === "function" &&
            typeof Reflect.get(api, "path") === "string"
              ? [Reflect.get(api, "path") as string]
              : [],
          );
          const { match, options } = declaration;
          const patterns =
            typeof match === "string"
              ? [match]
              : Array.isArray(match)
                ? match
                : [];
          for (const pattern of patterns) {
            if (!paths.includes(pattern)) {
              const closest = [...paths].sort(
                (a, b) => distance(a, pattern) - distance(b, pattern),
              )[0];
              issues.push(
                new BetterAuthConfigurationError(
                  "UNKNOWN_HOOK_PATH",
                  `Hook '${wrapper.name}.${String(method)}' has unknown path '${pattern}'.`,
                  closest
                    ? `Did you mean '${closest}'?`
                    : "Use an endpoint path exposed by this auth instance.",
                ),
              );
            }
          }
          const hook: CompiledHook = {
            matches(ctx, scope) {
              const router = Reflect.get(ctx, "_flag") === "router";
              if (
                (options.calls === "http" && !router) ||
                (options.calls === "server" && router) ||
                (options.skipInternal && scope?.internal)
              ) {
                return false;
              }
              if (match === undefined) {
                return true;
              }
              if (typeof match === "function") {
                return match(ctx as AuthHookContext);
              }
              return typeof match === "string"
                ? ctx.path === match
                : match.includes(ctx.path ?? "");
            },
            async run(ctx) {
              return handler.call(instance, ctx);
            },
          };
          const list = endpoint.get(name) ?? [];
          list.push({
            phase: declaration.phase,
            order: options.order ?? 0,
            hook,
          });
          endpoint.set(name, list);
        }
        for (const declaration of metadata.databaseHooks) {
          const name = declaration.options.instance ?? "default";
          if (!registrations.has(name)) {
            issues.push(
              new BetterAuthConfigurationError(
                "UNKNOWN_INSTANCE",
                `Database hook '${wrapper.name}.${String(method)}' names unknown instance '${name}'.`,
              ),
            );
            continue;
          }
          const list = database.get(name) ?? [];
          list.push({
            phase: declaration.phase,
            target: declaration.target,
            order: declaration.options.order ?? 0,
            hook: handler.bind(instance),
          });
          database.set(name, list);
        }
      }
      if (found) {
        const owner = wrapper.host?.name ?? "unknown module";
        const previous = discovered.get(wrapper.metatype);
        if (previous) {
          this.logger.warn(
            `W_DUPLICATE_HOOK_PROVIDER: '${wrapper.name}' is provided in '${previous}' and '${owner}'; both registrations run.`,
          );
        }
        discovered.set(wrapper.metatype, owner);
      }
    }
    const tables = new Map<string, HookTables>();
    for (const name of registrations) {
      const hooks = (endpoint.get(name) ?? []).sort(
        (a, b) => a.order - b.order,
      );
      const db = (database.get(name) ?? []).sort((a, b) => a.order - b.order);
      tables.set(name, {
        before: hooks
          .filter((value) => value.phase === "before")
          .map((value) => value.hook),
        after: hooks
          .filter((value) => value.phase === "after")
          .map((value) => value.hook),
        database: Object.fromEntries(
          DATABASE_TARGETS.map((target) => [
            target,
            {
              before: db
                .filter(
                  (value) =>
                    value.target === target && value.phase === "before",
                )
                .map((value) => value.hook),
              after: db
                .filter(
                  (value) => value.target === target && value.phase === "after",
                )
                .map((value) => value.hook),
            },
          ]),
        ) as unknown as BridgeBinding["database"],
      });
    }
    return tables;
  }
}
