import { createRuntime } from "@devteam/agents";
import { emitEvent } from "@devteam/db";

/**
 * One in-process queue per room. A new user message waits for the previous
 * orchestration to finish, so two humans (or a human + a handoff) cannot
 * interleave writes for the same conversation.
 */
class RoomQueue {
  private chains = new Map<string, Promise<void>>();
  private controllers = new Map<string, AbortController>();

  enqueue(roomId: string, task: (signal: AbortSignal) => Promise<void>): void {
    const controller = new AbortController();
    this.controllers.set(roomId, controller);
    const previous = this.chains.get(roomId) ?? Promise.resolve();
    const run = previous.then(
      () => task(controller.signal),
      () => task(controller.signal),
    );
    const guarded = run
      .catch((error) => {
        console.error("[orchestrator] run failed", error instanceof Error ? error.message : error);
      })
      .finally(() => {
        if (this.chains.get(roomId) === guarded) this.chains.delete(roomId);
        if (this.controllers.get(roomId) === controller) this.controllers.delete(roomId);
      });
    this.chains.set(roomId, guarded);
  }

  stop(roomId: string): boolean {
    const controller = this.controllers.get(roomId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  isRunning(roomId: string): boolean {
    return this.chains.has(roomId);
  }
}

export const roomQueue = new RoomQueue();

/** One code run per workspace at a time. */
class WorkQueue {
  private chains = new Map<string, Promise<void>>();
  private controllers = new Map<string, AbortController>();

  enqueue(workspaceId: string, task: (signal: AbortSignal) => Promise<void>): void {
    const controller = new AbortController();
    this.controllers.set(workspaceId, controller);
    const previous = this.chains.get(workspaceId) ?? Promise.resolve();
    const run = previous.then(
      () => task(controller.signal),
      () => task(controller.signal),
    );
    const guarded = run
      .catch((error) => {
        console.error("[workspace] run failed", error instanceof Error ? error.message : error);
      })
      .finally(() => {
        if (this.chains.get(workspaceId) === guarded) this.chains.delete(workspaceId);
        if (this.controllers.get(workspaceId) === controller) {
          this.controllers.delete(workspaceId);
        }
      });
    this.chains.set(workspaceId, guarded);
  }

  isRunning(workspaceId: string): boolean {
    return this.chains.has(workspaceId);
  }

  stop(workspaceId: string): boolean {
    const controller = this.controllers.get(workspaceId);
    if (!controller) return false;
    controller.abort();
    return true;
  }
}

export const workQueue = new WorkQueue();
export const runtime = createRuntime();

/** Emit helper that injects the scope required by the persisted event log. */
export function projectEmitter(tenantId: string, projectId: string) {
  return async (type: string, payload: Record<string, unknown>) => {
    await emitEvent({ tenantId, projectId, type, payload: { ...payload, projectId } });
  };
}
