import {
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import { Observable } from "rxjs";
import type { PrincipalReading, TransportCall } from "./auth-contracts.js";
import { AUTH_ENHANCER, READER_CONTEXT, SCOPE_CORE } from "./auth-tokens.js";
import type { ScopeView } from "./bridge-protocol.js";
import type { InstanceLookup } from "./instance-registry.js";
import type { PrincipalReadings } from "./principal-readings.js";
import { requestHeaders } from "./principal-resolver.js";
import type { RequestScope, ScopeState } from "./request-scope.js";
import type { RoutePlanner } from "./route-planner.js";
import type { TransportRegistry } from "./transport-registry.js";

@Injectable()
export class BetterAuthScopeInterceptor implements NestInterceptor {
  static readonly [AUTH_ENHANCER] = "scope";
  readonly [AUTH_ENHANCER] = "scope";

  constructor(
    @Inject(SCOPE_CORE) private readonly core: Pick<ScopeCore, "intercept">,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return this.core.intercept(context, next);
  }
}
export class ScopeCore implements NestInterceptor {
  constructor(
    private readonly instances: InstanceLookup,
    private readonly planner: RoutePlanner,
    private readonly transports: TransportRegistry,
    private readonly scope: RequestScope,
    private readonly readings: PrincipalReadings,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const plan = this.planner.forContext(context);
    const entry = this.instances.get(plan.instance);
    let described = false;
    let call: TransportCall | undefined;
    const getCall = (): TransportCall | undefined => {
      if (!described) {
        const transport = this.transports.find(context);
        call = transport
          ? this.transports.describe(context, transport)
          : undefined;
        described = true;
      }
      return call;
    };
    let reading: PrincipalReading | undefined;
    const read = (): PrincipalReading => {
      if (reading) {
        return reading;
      }
      const lineage = this.transports.find(context)?.lineage?.(context);
      reading = this.readings.read({
        args: context.getArgs(),
        plan,
        lineage,
        ...(plan.access === "public" || plan.access === "inherit"
          ? {}
          : { call: getCall() }),
      });
      return reading;
    };
    const instances = this.instances;
    const view: ScopeView = {
      get cookies() {
        return getCall()?.cookies ?? null;
      },
      forward: plan.forwardDirectCalls ? "same-credential" : "none",
      internal: false,
      get inbound() {
        return () => {
          const call = getCall();
          return call ? requestHeaders(call, entry) : new Headers();
        };
      },
      get browserHeaders() {
        const browser = getCall()?.browser;
        return browser ? () => browser.headers() : undefined;
      },
      get checkCallerSession() {
        if (plan.originCheck === "off") {
          return undefined;
        }
        const browser = getCall()?.browser;
        return browser
          ? (path: string, instance: string) =>
              instances
                .get(instance)
                .origin.assertCallerSession(browser, path, instance)
          : undefined;
      },
    };
    const state: ScopeState = {
      view,
      plan,
      reading: read,
      get call() {
        return getCall();
      },
    };
    const args = context.getArgs();
    const bridge = {
      args: [...args],
      reading: read,
      scope: this.scope,
      readings: this.readings,
    };
    for (const arg of [args, ...args]) {
      if (
        arg &&
        (typeof arg === "object" || typeof arg === "function") &&
        Object.isExtensible(arg)
      ) {
        Object.defineProperty(arg, READER_CONTEXT, {
          value: bridge,
          configurable: true,
        });
      }
    }
    return new Observable((subscriber) =>
      this.scope.run(state, () => {
        const subscription = next.handle().subscribe({
          next: (value) => this.scope.run(state, () => subscriber.next(value)),
          error: (error) =>
            this.scope.run(state, () => subscriber.error(error)),
          complete: () => this.scope.run(state, () => subscriber.complete()),
        });
        return () => this.scope.run(state, () => subscription.unsubscribe());
      }),
    );
  }
}
