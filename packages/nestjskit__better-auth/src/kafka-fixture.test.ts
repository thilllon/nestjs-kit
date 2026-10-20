import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { ConsumerReadiness, type ObservedConsumer } from "./kafka-fixture.js";

/** A consumer that emits the kafkajs instrumentation events the test drives. */
class FakeConsumer implements ObservedConsumer {
  readonly events = {
    GROUP_JOIN: "consumer.group_join",
    FETCH_START: "consumer.fetch_start",
    FETCH: "consumer.fetch",
    CRASH: "consumer.crash",
  };

  readonly #emitter = new EventEmitter();

  on(
    eventName: string,
    listener: (event: { payload: unknown }) => void,
  ): () => void {
    this.#emitter.on(eventName, listener);
    return () => this.#emitter.off(eventName, listener);
  }

  join(memberAssignment: Record<string, number[]>): void {
    this.#emitter.emit(this.events.GROUP_JOIN, {
      payload: { memberAssignment },
    });
  }

  fetchStart(): void {
    this.#emitter.emit(this.events.FETCH_START, { payload: { nodeId: 1 } });
  }

  fetch(): void {
    this.#emitter.emit(this.events.FETCH, { payload: { nodeId: 1 } });
  }

  crash(error: Error, restart: boolean): void {
    this.#emitter.emit(this.events.CRASH, { payload: { error, restart } });
  }

  listeners(): number {
    return Object.values(this.events).reduce(
      (count, name) => count + this.#emitter.listenerCount(name),
      0,
    );
  }
}

const topics = ["run.required", "run.optional"];
const assigned = { "run.required": [0], "run.optional": [0] };

describe("Kafka consumer readiness", () => {
  it("waits for a fetch that starts after a join assigning every topic", async () => {
    const consumer = new FakeConsumer();
    const readiness = new ConsumerReadiness(consumer, topics);
    // A fetch in flight across a join may have resolved its offsets before that join.
    consumer.fetchStart();
    consumer.join(assigned);
    consumer.fetch();
    consumer.fetchStart();
    consumer.join(assigned);
    consumer.fetch();
    await expect(readiness.wait("the consumer", 20)).rejects.toThrow(
      "the consumer was not ready in 20 ms: it has not completed a fetch since joining its group",
    );
    consumer.fetchStart();
    consumer.fetch();
    await expect(readiness.wait("the consumer", 20)).resolves.toBeUndefined();
    expect(consumer.listeners()).toBe(0);
  });

  it("stays pending while the last join leaves a topic unassigned", async () => {
    const consumer = new FakeConsumer();
    const readiness = new ConsumerReadiness(consumer, topics);
    await expect(readiness.wait("the consumer", 20)).rejects.toThrow(
      "it has not joined its group",
    );
    consumer.join({ "run.required": [0], "run.optional": [] });
    consumer.fetchStart();
    consumer.fetch();
    await expect(readiness.wait("the consumer", 20)).rejects.toThrow(
      "its last group join assigned no partition of run.optional",
    );
    // kafkajs rejoins once it finds the assignment stale.
    consumer.join(assigned);
    consumer.fetchStart();
    consumer.fetch();
    await expect(readiness.wait("the consumer", 20)).resolves.toBeUndefined();
  });

  it("fails on a crash without restart and keeps waiting through a restart", async () => {
    const consumer = new FakeConsumer();
    const readiness = new ConsumerReadiness(consumer, topics);
    consumer.crash(new Error("retriable"), true);
    consumer.join(assigned);
    consumer.fetchStart();
    consumer.fetch();
    await expect(readiness.wait("the consumer", 20)).resolves.toBeUndefined();

    const crashed = new FakeConsumer();
    const failed = new ConsumerReadiness(crashed, topics);
    crashed.crash(new Error("broker gone"), false);
    await expect(failed.wait("the consumer", 20)).rejects.toThrow(
      "broker gone",
    );
    expect(crashed.listeners()).toBe(0);
  });
});
