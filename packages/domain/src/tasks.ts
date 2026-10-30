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

/**
 * Best-effort owner for a task that was created without an assignee. The
 * scheduler uses this only to repair orphaned proposals: a task with no
 * `roleKey` can never enter the assignee-confirmation step, so it would sit in
 * `proposed` forever and keep the coding gate closed. The assigned role still
 * has to accept the task; this is routing, not approval.
 */
const TASK_ROLE_HINTS: Array<{ role: string; pattern: RegExp }> = [
  { role: "security", pattern: /安全|渗透|漏洞|威胁|越权|注入|证书|https|secure\s*cookie|限速|口令|凭据/i },
  { role: "qa", pattern: /测试|用例|验收|回归|复现|证据|预演|dry-run|spec\s*review|test\s*report/i },
  {
    role: "devops",
    pattern: /部署|运维|健康检查|监控|回滚|容器|docker|systemd|端口|发布|防火墙|实例|冷备|备份/i,
  },
  { role: "frontend", pattern: /前端|页面|组件|路由|交互|样式|浏览器|react|vue|ui\b/i },
  { role: "backend", pattern: /后端|接口|数据库|迁移|事务|sql|服务端|端点|权限|触发器|外键|schema/i },
  { role: "architect", pattern: /架构|契约|技术方案|数据模型|adr|选型|设计/i },
  { role: "pm", pattern: /prd|需求|产品|用户故事|验收标准|范围|优先级/i },
];

export function inferTaskRoleKey(input: {
  mode?: string | null;
  title: string;
  description?: string | null;
  availableRoles?: readonly string[];
}): string {
  const available = input.availableRoles?.length ? new Set(input.availableRoles) : null;
  const usable = (role: string) => !available || available.has(role);
  const text = `${input.title}\n${input.description ?? ""}`;

  for (const hint of TASK_ROLE_HINTS) {
    if (hint.pattern.test(text) && usable(hint.role)) return hint.role;
  }
  const fallback = input.mode === "workbench" ? "devops" : "backend";
  if (usable(fallback)) return fallback;
  return input.availableRoles?.find((role) => role !== "lead") ?? "lead";
}
