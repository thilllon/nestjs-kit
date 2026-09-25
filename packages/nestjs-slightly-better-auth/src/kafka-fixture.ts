import { ClientKafka, ServerKafka } from "@nestjs/microservices";

/**
 * Consumer settings for the Compose broker. An idle fetch long-polls for `maxWaitTimeInMs`, and both the readiness
 * wait and `consumer.disconnect()` wait for the fetch in flight, so the kafkajs default of 5000 ms adds up to 5 s to
 * every boot and close. A short `metadataMaxAge` lets a consumer whose join predates a new topic's partition metadata
 * detect its stale assignment and rejoin, which emits another group join.
 */
export const kafkaTestConsumer = {
  maxWaitTimeInMs: 100,
  metadataMaxAge: 1000,
} as const;

/** The kafkajs consumer instrumentation that readiness observes. */
export interface ObservedConsumer {
  readonly events: {
    readonly GROUP_JOIN: string;
    readonly FETCH_START: string;
    readonly FETCH: string;
    readonly CRASH: string;
  };
  on(
    eventName: string,
    listener: (event: { payload: unknown }) => void,
  ): () => void;
}

/**
 * Tracks when a consumer receives every message produced from now on. `consumer.run()` resolves after the group join,
 * but a new group without committed offsets resolves `fromBeginning: false` to the log end only inside its first fetch,
 * which kafkajs retries while a fresh partition's leader cannot list offsets yet. A message produced before that fetch
 * lands below the resolved offset and is never delivered. The consumer is ready once a fetch that started after a
 * group join assigning every topic has completed: its start offsets are fixed below any later message.
 */
export class ConsumerReadiness {
  /** Topics without an assigned partition in the last join; undefined before the first join. */
  #unassigned: readonly string[] | undefined;
  #fetchingAfterJoin = false;
  #settled = false;
  readonly #removers: (() => void)[] = [];
  readonly #ready: Promise<void>;

  constructor(
    consumer: ObservedConsumer,
    readonly topics: readonly string[],
  ) {
    this.#ready = new Promise<void>((resolve, reject) => {
      const settle = (error?: Error) => {
        if (this.#settled) {
          return;
        }
        this.#settled = true;
        for (const remove of this.#removers) {
          remove();
        }
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      this.#removers.push(
        consumer.on(consumer.events.GROUP_JOIN, ({ payload }) => {
          const assignment = (
            payload as { memberAssignment: Record<string, number[]> }
          ).memberAssignment;
          this.#unassigned = topics.filter(
            (topic) => (assignment[topic]?.length ?? 0) === 0,
          );
          this.#fetchingAfterJoin = false;
        }),
        consumer.on(consumer.events.FETCH_START, () => {
          this.#fetchingAfterJoin = this.#unassigned?.length === 0;
        }),
        consumer.on(consumer.events.FETCH, () => {
          if (this.#fetchingAfterJoin) {
            settle();
          }
        }),
        // kafkajs restarts a consumer after a retriable crash, which joins its group again.
        consumer.on(consumer.events.CRASH, ({ payload }) => {
          const crash = payload as { error: Error; restart: boolean };
          if (!crash.restart) {
            settle(crash.error);
          }
        }),
      );
    });
    // A crash before anyone waits must not surface as an unhandled rejection.
    this.#ready.catch(() => undefined);
  }

  /** Why the consumer is not ready yet. */
  pending(): string {
    if (this.#unassigned === undefined) {
      return "it has not joined its group";
    }
    if (this.#unassigned.length > 0) {
      return `its last group join assigned no partition of ${this.#unassigned.join(", ")}`;
    }
    return "it has not completed a fetch since joining its group";
  }

  /** Resolves once ready; rejects on a crash without restart, or after `timeoutMs` with what is still pending. */
  async wait(label: string, timeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.#ready,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `${label} was not ready in ${timeoutMs} ms: ${this.pending()}`,
                ),
              ),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The built-in Kafka server, observing its consumer so that callers can wait until it receives new requests. */
export class ReadyServerKafka extends ServerKafka {
  #readiness: ConsumerReadiness | undefined;

  override async bindEvents(
    consumer: Parameters<ServerKafka["bindEvents"]>[0],
  ): Promise<void> {
    this.#readiness = new ConsumerReadiness(consumer, [
      ...this.messageHandlers.keys(),
    ]);
    await super.bindEvents(consumer);
  }

  /** Resolves once the listening server's consumer receives every request produced from now on. */
  async ready(timeoutMs: number): Promise<void> {
    if (!this.#readiness) {
      throw new Error("The Kafka server has not subscribed to its patterns");
    }
    await this.#readiness.wait(
      `The Kafka server consumer group ${this.groupId}`,
      timeoutMs,
    );
  }
}

/** The built-in Kafka client, observing its reply consumer so that callers can wait until it receives new replies. */
export class ReadyClientKafka extends ClientKafka {
  #readiness: ConsumerReadiness | undefined;

  override async bindTopics(): Promise<void> {
    this.#readiness = new ConsumerReadiness(this.consumer, [
      ...this.responsePatterns,
    ]);
    await super.bindTopics();
  }

  /** Resolves once the connected client's reply consumer receives every reply produced from now on. */
  async ready(timeoutMs: number): Promise<void> {
    if (!this.#readiness) {
      throw new Error("The Kafka client has not subscribed to its replies");
    }
    await this.#readiness.wait(
      `The Kafka client consumer group ${this.groupId}`,
      timeoutMs,
    );
  }
}
