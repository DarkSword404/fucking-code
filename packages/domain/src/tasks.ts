import type { TaskStatus } from "@devteam/contracts";

const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  proposed: ["ready", "cancelled"],
  ready: ["in_progress", "blocked", "cancelled", "needs_replan"],
  in_progress: ["review", "blocked", "failed", "done", "cancelled", "needs_replan"],
  review: ["testing", "done", "in_progress", "blocked"],
  testing: ["done", "failed", "in_progress"],
  blocked: ["ready", "in_progress", "cancelled", "needs_replan"],
  failed: ["ready", "in_progress", "cancelled"],
  needs_replan: ["ready", "cancelled"],
  stale: ["needs_replan", "cancelled"],
  done: [],
  cancelled: [],
};

export const TERMINAL_TASK_STATUSES: TaskStatus[] = ["done", "cancelled"];

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true;
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransitionTask(from, to)) {
    throw new Error(`Illegal task transition: ${from} -> ${to}`);
  }
}

export function isTaskOpen(status: TaskStatus): boolean {
  return !TERMINAL_TASK_STATUSES.includes(status);
}
