import { describe, expect, test } from "vitest";
import { KeyedQueue } from "../apps/api/src/orchestration.js";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("keyed work queue", () => {
  test("serializes work per key and frees the key afterwards", async () => {
    const queue = new KeyedQueue();
    const order: number[] = [];
    queue.enqueue("room", async () => {
      order.push(1);
      await wait(10);
      order.push(2);
    });
    queue.enqueue("room", async () => {
      order.push(3);
    });

    expect(queue.isRunning("room")).toBe(true);
    await wait(40);
    expect(order).toEqual([1, 2, 3]);
    expect(queue.isRunning("room")).toBe(false);
  });

  test("stop aborts every queued item, not just the newest", async () => {
    const queue = new KeyedQueue();
    const signals: AbortSignal[] = [];
    queue.enqueue("room", async (signal) => {
      signals.push(signal);
      await wait(20);
    });
    queue.enqueue("room", async (signal) => {
      signals.push(signal);
    });

    await wait(1);
    expect(queue.stop("room")).toBe(true);
    await wait(30);
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  test("aborts overdue work and drops a chain that ignores the abort", async () => {
    const queue = new KeyedQueue();
    let signal: AbortSignal | undefined;
    let started = false;
    queue.enqueue("wedged", (itemSignal) => {
      signal = itemSignal;
      started = true;
      // Never resolves and ignores the abort, like a stuck database call.
      return new Promise<void>(() => {});
    });

    await wait(5);
    expect(started).toBe(true);
    expect(queue.abortStale(0, 0)).toBe(1);
    expect(signal?.aborted).toBe(true);
    expect(queue.isRunning("wedged")).toBe(true);

    expect(queue.abortStale(0, 0)).toBe(1);
    expect(queue.isRunning("wedged")).toBe(false);

    // A dropped chain must not block new work on the same key.
    let ran = false;
    queue.enqueue("wedged", async () => {
      ran = true;
    });
    await wait(5);
    expect(ran).toBe(true);
    expect(queue.isRunning("wedged")).toBe(false);
  });
});
