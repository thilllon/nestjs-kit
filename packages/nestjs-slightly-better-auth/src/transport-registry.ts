import type { ExecutionContext } from "@nestjs/common";
import type {
  AuthTransport,
  TransportCall,
  TransportKit,
} from "./auth-contracts.js";
import { BetterAuthConfigurationError } from "./auth-errors.js";

export class TransportRegistry {
  private transports: readonly AuthTransport[] = [];
  private readonly owners = new WeakMap<TransportCall, string>();
  private kit: TransportKit = { http: null };

  register(transports: readonly AuthTransport[]): void {
    this.transports = [...transports];
  }

  setKit(kit: TransportKit): void {
    this.kit = kit;
  }

  list(): readonly AuthTransport[] {
    return [...this.transports];
  }

  // biome-ignore lint/complexity/noBannedTypes: Nest handler metadata preserves the framework function identity.
  defaultAccessFor(target: Function, method: string): "inherit" | undefined {
    for (const transport of this.transports) {
      const answer = transport.defaultAccessFor?.(target, method);
      if (answer !== undefined) {
        return answer;
      }
    }
    return undefined;
  }

  find(context: ExecutionContext): AuthTransport | undefined {
    return this.transports.find((unit) => unit.handles(context));
  }

  select(context: ExecutionContext): AuthTransport {
    const transport = this.find(context);
    if (!transport) {
      throw BetterAuthConfigurationError.atRequest(
        "NO_TRANSPORT",
        "No registered transport handles this execution context",
      );
    }
    return transport;
  }

  idOf(call: TransportCall): string {
    return this.owners.get(call) ?? "unknown";
  }

  describe(
    context: ExecutionContext,
    transport = this.select(context),
  ): TransportCall {
    const call = transport.describe(context, this.kit);
    this.owners.set(call, transport.id);
    return call;
  }
}
