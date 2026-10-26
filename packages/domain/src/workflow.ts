import type { WorkflowPhase } from "@devteam/contracts";
import { WORKFLOW_PHASES } from "@devteam/contracts";

export const PHASE_ORDER: WorkflowPhase[] = [...WORKFLOW_PHASES];

export function nextPhase(phase: WorkflowPhase): WorkflowPhase | null {
  const i = PHASE_ORDER.indexOf(phase);
  if (i < 0 || i >= PHASE_ORDER.length - 1) return null;
  return PHASE_ORDER[i + 1]!;
}

export function phaseIndex(phase: WorkflowPhase): number {
  return PHASE_ORDER.indexOf(phase);
}

/**
 * Agile phase graph. Forward edges are gated; backward/iteration edges are
 * explicit loops that require a human-confirmed reason.
 */
export const PHASE_TRANSITIONS: Record<WorkflowPhase, WorkflowPhase[]> = {
  intake: ["discovery"],
  discovery: ["discovery", "design", "planning"],
  design: ["design", "discovery", "planning"],
  planning: ["planning", "design", "build"],
  build: ["build", "planning", "test"],
  test: ["test", "build", "review"],
  review: ["review", "test", "build", "deliver"],
  deliver: ["deliver", "planning", "done"],
  done: ["discovery", "planning"],
};

export function canTransitionPhase(from: WorkflowPhase, to: WorkflowPhase): boolean {
  return from !== to && (PHASE_TRANSITIONS[from]?.includes(to) ?? false);
}

/**
 * Transition rules are data, not prompt text. The API refuses illegal moves;
 * a human owner may force a move only with a recorded reason (audited).
 */
export function assertTransition(from: WorkflowPhase, to: WorkflowPhase): void {
  if (!canTransitionPhase(from, to)) {
    throw new Error(
      `Illegal phase transition: ${from} -> ${to} (allowed: ${PHASE_TRANSITIONS[from]?.join(", ") ?? "none"})`,
    );
  }
}

export const PHASE_DESCRIPTIONS: Record<WorkflowPhase, string> = {
  intake: "用户刚提出目标，团队还没开始澄清。",
  discovery: "PM 正在澄清需求、边界和验收标准。",
  design: "架构师正在给出技术方案、接口契约和风险。",
  planning: "Lead 正在把方案拆成有依赖关系的任务。",
  build: "开发 Agent 正在实现任务并提交可审查的变更。",
  test: "QA 正在设计并执行验证，缺陷进入修复闭环。",
  review: "等待人类评审代码、测试证据和交付范围。",
  deliver: "准备 PR / 交付物，等待最终审批。",
  done: "本阶段研发已交付完成。",
};

export type PhaseGateContext = {
  artifacts: Array<{ kind: string; status: string; title: string }>;
  tasks: Array<{ status: string }>;
  approvals: Array<{ targetType: string; status: string }>;
};

export interface GateRequirement {
  key: string;
  label: string;
  met: boolean;
}

/** Requirements that must be satisfied before leaving `phase`. */
export function gateRequirements(phase: WorkflowPhase, ctx: PhaseGateContext): GateRequirement[] {
  const hasAccepted = (kind: string) =>
    ctx.artifacts.some((a) => a.kind === kind && a.status === "accepted");
  const hasArtifact = (kind: string) => ctx.artifacts.some((a) => a.kind === kind);
  const openTasks = ctx.tasks.filter((t) => t.status !== "done" && t.status !== "cancelled");

  switch (phase) {
    case "discovery":
      return [
        {
          key: "prd_accepted",
          label: "PRD 已生成并被人确认",
          met: hasAccepted("prd"),
        },
        {
          key: "acceptance_criteria",
          label: "验收标准已生成并被人确认",
          met: hasAccepted("acceptance_criteria"),
        },
      ];
    case "design":
      return [
        { key: "design_accepted", label: "技术方案已生成并被人确认", met: hasAccepted("design") },
      ];
    case "planning":
      return [
        {
          key: "current_prd",
          label: "当前 PRD 版本已确认",
          met: hasAccepted("prd"),
        },
        {
          key: "current_acceptance",
          label: "当前验收标准版本已确认",
          met: hasAccepted("acceptance_criteria"),
        },
        { key: "has_tasks", label: "至少拆出 1 个可执行任务", met: ctx.tasks.length > 0 },
      ];
    case "build":
      return [
        {
          key: "tasks_closed",
          label: "所有开发任务已完成或取消",
          met: ctx.tasks.length > 0 && openTasks.length === 0,
        },
      ];
    case "test":
      return [
        {
          key: "test_report",
          label: "测试报告已生成并确认",
          met: hasAccepted("test_report"),
        },
      ];
    case "review":
      return [
        {
          key: "review_approval",
          label: "代码评审已获人工批准",
          met: ctx.approvals.some((a) => a.targetType === "phase_review" && a.status === "approved"),
        },
      ];
    case "deliver":
      return [
        {
          key: "delivery_approval",
          label: "交付 / 创建 PR 已获人工批准",
          met: ctx.approvals.some((a) => a.targetType === "delivery" && a.status === "approved"),
        },
      ];
    default:
      return [];
  }
}

export function gateRequirementsForTransition(
  from: WorkflowPhase,
  to: WorkflowPhase,
  ctx: PhaseGateContext,
): GateRequirement[] {
  if (!canTransitionPhase(from, to)) {
    return [{ key: "legal_transition", label: "阶段转移合法", met: false }];
  }
  // Forward moves must satisfy the current phase gate. Backward moves and
  // iteration loops (e.g. test -> build, done -> planning) are allowed when
  // the client confirms, because they represent rework or a new sprint.
  if (phaseIndex(to) <= phaseIndex(from)) return [];
  return gateRequirements(from, ctx);
}

export function canAdvance(phase: WorkflowPhase, ctx: PhaseGateContext): boolean {
  if (!nextPhase(phase)) return false;
  return gateRequirements(phase, ctx).every((r) => r.met);
}
