import type {
  AuthPrincipalBase,
  PrincipalResolver,
  PrincipalResult,
  PrincipalSource,
  ResolutionRequest,
  TransportCall,
} from "./auth-contracts.js";
import {
  type AuthFailure,
  isAuthFailure,
  normalizeThrown,
  createInfrastructureError,
  isConfigurationError,
  isInfrastructureError,
} from "./auth-errors.js";
import type { InstanceEntry, InstanceLookup } from "./instance-registry.js";
import type { TransportRegistry } from "./transport-registry.js";
import type { RequestScope } from "./request-scope.js";

export const definePrincipalSource = <P extends AuthPrincipalBase>(
  source: PrincipalSource<P>,
): PrincipalSource<P> => source;
export const authenticated = <P extends AuthPrincipalBase>(
  principal: P,
): PrincipalResult<P> => ({ outcome: "authenticated", principal });
export const absent = (): PrincipalResult<never> => ({ outcome: "absent" });
export const rejected = (failure: AuthFailure): PrincipalResult<never> => ({
  outcome: "rejected",
  failure,
});

export class MemoKeys {
  private readonly objects = new WeakMap<object, number>();
  private readonly symbols = new Map<symbol, number>();
  private next = 0;

  key(namespace: string, value: string | object | symbol): string {
    if (typeof value === "string") {
      return JSON.stringify([namespace, "string", value]);
    }
    const map = typeof value === "symbol" ? this.symbols : this.objects;
    let id = (map as Map<object | symbol, number>).get(value);
    if (id === undefined) {
      id = ++this.next;
      (map as Map<object | symbol, number>).set(value, id);
    }
    return JSON.stringify([namespace, typeof value, id]);
  }
}
export function requestHeaders(
  call: TransportCall,
  entry: InstanceEntry,
): Headers {
  const headers = new Headers(call.headers());
  for (const name of [...headers.keys()]) {
    if (
      name.startsWith(":") ||
      name.startsWith("x-nsba-ip-") ||
      name === entry.bridge.clientIpHeader
    ) {
      headers.delete(name);
    }
  }
  if (entry.bridge.clientIpHeader && call.clientIp) {
    headers.set(entry.bridge.clientIpHeader, call.clientIp);
  }
  return headers;
}
export function normalizeForRequest(
  error: unknown,
  where: "source" | "policy",
  site: string,
  entry: InstanceEntry,
  headers: Headers,
) {
  try {
    return normalizeThrown(error, where, site, [], entry.options.errors);
  } catch (normalized) {
    if (
      isConfigurationError(normalized) ||
      (isInfrastructureError(error) && normalized === error)
    ) {
      throw normalized;
    }
    throw createInfrastructureError(error, {
      headers,
      credentialHeaders: entry.credentialHeaders,
      exposeRawCause: entry.options.errors?.exposeRawCause,
    });
  }
}
export class ChainPrincipalResolver implements PrincipalResolver {
  private readonly keys = new MemoKeys();

  constructor(
    private readonly instances: InstanceLookup,
    private readonly scope: RequestScope,
    private readonly transports: TransportRegistry,
  ) {}

  resolve(
    call: TransportCall,
    request: ResolutionRequest,
  ): Promise<PrincipalResult> {
    const entry = this.instances.get(request.auth.name);
    const compute = async (): Promise<PrincipalResult> => {
      const headers = requestHeaders(call, entry);
      const sources = request.reclassify
        ? entry.sources.filter(
            (source) =>
              source.id === request.reclassify!.sourceId &&
              source.sessionBacked,
          )
        : entry.sources.filter((source) =>
            source.kinds.some((kind) => request.accepts.has(kind)),
          );
      return request.auth.run(
        {
          cookies: call.cookies,
          forward: "same-credential",
          inbound: () => headers,
          internal: true,
        },
        async () => {
          for (const source of sources) {
            const input = {
              headers,
              cookies: call.cookies,
              transport: this.transports.idOf(call),
              request: call.request,
              freshness: request.freshness,
              auth: request.auth,
              memo: <T>(
                key: string | object | symbol,
                fn: () => Promise<T>,
              ): Promise<T> =>
                this.scope.memoPolicyIo(
                  call.key,
                  entry.name,
                  this.keys.key(`source:${source.id}`, key),
                  fn,
                  entry.options.limits?.maxAuthorizationCallsPerRequest,
                ),
            };
            try {
              if (source.appliesTo && !source.appliesTo(input)) {
                continue;
              }
              const result = await source.resolve(input);
              if (
                result.outcome === "authenticated" &&
                (!source.kinds.includes(result.principal.kind) ||
                  result.principal.source !== source.id ||
                  Boolean(result.principal.delegation) !==
                    Boolean(source.delegates))
              ) {
                throw new Error(
                  `Principal source ${source.id} violated its declared principal contract`,
                );
              }
              if (result.outcome !== "absent") {
                return result;
              }
            } catch (error) {
              const failure = normalizeForRequest(
                error,
                "source",
                source.id,
                entry,
                headers,
              );
              if (isAuthFailure(failure)) {
                return rejected(failure);
              }
              throw error;
            }
          }
          return absent();
        },
      );
    };
    return request.reclassify
      ? compute()
      : this.scope.memoPrincipal(
          call,
          {
            instance: entry.name,
            freshness: request.freshness,
            sourceSet: request.sourceSet,
          },
          compute,
        );
  }
}
