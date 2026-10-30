import { createRuntime } from "@devteam/agents";
import { emitEvent } from "@devteam/db";

/**
 * One FIFO chain per key. A new user message waits for the previous
 * orchestration to finish, so two humans (or a human + a handoff) cannot
 * interleave writes for the same conversation.
 *
 * A chain whose task never settles would otherwise block that key forever
 * (`isRunning` stays true and every scheduler tick returns early). The
 * watchdog (`abortStale`) aborts overdue tasks and, as a last resort, drops a
 * wedged chain so new work can start. Dropped chains are safe: their `finally`
 * only clears the map when it still owns the current entry.
 */
export class KeyedQueue {
  private chains = new Map<string, Promise<void>>();
  private controllers = new Map<string, Set<AbortController>>();
  private activeControllers = new Map<string, AbortController>();
  private startedAt = new Map<string, number>();
  private abortedAt = new Map<string, number>();

  enqueue(key: string, task: (signal: AbortSignal) => Promise<void>): void {
    const controller = new AbortController();
    const controllers = this.controllers.get(key) ?? new Set<AbortController>();
    controllers.add(controller);
    this.controllers.set(key, controllers);

    const previous = this.chains.get(key) ?? Promise.resolve();
    // Start the clock when this item actually begins, not when it is queued:
    // otherwise a long-running predecessor makes queued work look overdue.
    const run = previous.then(
      () => {
        this.startedAt.set(key, Date.now());
        this.abortedAt.delete(key);
        this.activeControllers.set(key, controller);
        return task(controller.signal);
      },
      () => {
        this.startedAt.set(key, Date.now());
        this.abortedAt.delete(key);
        this.activeControllers.set(key, controller);
        return task(controller.signal);
      },
    );
    const guarded = run
      .catch((error) => {
        console.error("[queue] run failed", error instanceof Error ? error.message : error);
      })
      .finally(() => {
        const remaining = this.controllers.get(key);
        remaining?.delete(controller);
        if (remaining && remaining.size === 0) this.controllers.delete(key);
        if (this.activeControllers.get(key) === controller) {
          this.activeControllers.delete(key);
        }
        if (this.chains.get(key) === guarded) {
          this.chains.delete(key);
          this.startedAt.delete(key);
          this.abortedAt.delete(key);
        }
      });
    this.chains.set(key, guarded);
  }

  stop(key: string): boolean {
    const controllers = this.controllers.get(key);
    if (!controllers?.size) return false;
    for (const controller of controllers) controller.abort();
    return true;
  }

  isRunning(key: string): boolean {
    return this.chains.has(key);
  }

  /**
   * Abort in-flight work and wait for the chains to settle before the caller
   * closes the database. A write racing `closeDb()` is how PGlite directories
   * get corrupted on restart.
   */
  async drain(timeoutMs = 15_000): Promise<void> {
    for (const controllers of this.controllers.values()) {
      for (const controller of controllers) controller.abort();
    }
    const chains = [...this.chains.values()];
    if (!chains.length) return;
    await Promise.race([
      Promise.allSettled(chains),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref()),
    ]);
  }

  /**
   * Abort work that exceeded its budget. If the task ignores the abort (for
   * example a stuck database call), drop the chain after a grace period so the
   * key is not locked for the lifetime of the process.
   */
  abortStale(maxMs: number, graceMs = maxMs): number {
    const now = Date.now();
    let recovered = 0;
    for (const [key, started] of this.startedAt) {
      const age = now - started;
      if (age < maxMs) continue;
      const abortedAt = this.abortedAt.get(key);
      if (!abortedAt) {
        this.abortedAt.set(key, now);
        // Abort only the run that is actually executing; queued items have
        // not consumed any budget yet.
        this.activeControllers.get(key)?.abort();
        console.error(
          `[queue] ${key} exceeded ${Math.round(maxMs / 1000)}s; aborting`,
        );
        recovered += 1;
        continue;
      }
      if (age >= maxMs + graceMs) {
        this.chains.delete(key);
        this.startedAt.delete(key);
        this.abortedAt.delete(key);
        this.controllers.delete(key);
        this.activeControllers.delete(key);
        console.error(
          `[queue] ${key} did not settle after abort; dropping wedged chain`,
        );
        recovered += 1;
      }
    }
    return recovered;
  }
}

export const roomQueue = new KeyedQueue();
/** One code run per workspace at a time. */
export const workQueue = new KeyedQueue();
export const runtime = createRuntime();

/** Abort overdue room turns / work runs. Called by the scheduler watchdog. */
export function guardStaleQueues(): number {
  const positive = (value: string | undefined, fallback: number): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  const roomMax = positive(process.env.ROOM_TURN_TIMEOUT_MS, 45 * 60_000);
  const roomGrace = positive(process.env.ROOM_TURN_GRACE_MS, 10 * 60_000);
  const workMax = positive(process.env.WORK_QUEUE_TIMEOUT_MS, 90 * 60_000);
  const workGrace = positive(process.env.WORK_QUEUE_GRACE_MS, 30 * 60_000);
  return (
    roomQueue.abortStale(roomMax, roomGrace) +
    workQueue.abortStale(workMax, workGrace)
  );
}

/** Emit helper that injects the scope required by the persisted event log. */
export function projectEmitter(tenantId: string, projectId: string) {
  return async (type: string, payload: Record<string, unknown>) => {
    await emitEvent({ tenantId, projectId, type, payload: { ...payload, projectId } });
  };
}
