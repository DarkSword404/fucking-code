import type { WorkflowPhase } from "@devteam/contracts";
import { WORKFLOW_PHASES } from "@devteam/contracts";

export const PHASE_ORDER: WorkflowPhase[] = [...WORKFLOW_PHASES];

export function nextPhase(phase: WorkflowPhase): WorkflowPhase | null {
  if (phase === "operations") return null;
  const i = PHASE_ORDER.indexOf(phase);
  if (i < 0 || i >= PHASE_ORDER.length - 1) return null;
  return PHASE_ORDER[i + 1]!;
}

export function phaseIndex(phase: WorkflowPhase): number {
  return PHASE_ORDER.indexOf(phase);
}

/**
 * Six-stage lifecycle graph. It is deliberately a graph: a new requirement can
 * restart at requirements, a failed test can return to coding, and operations
 * is a persistent service state rather than a terminal phase.
 */
export const PHASE_TRANSITIONS: Record<WorkflowPhase, WorkflowPhase[]> = {
  requirements: ["design"],
  design: ["requirements", "design", "coding"],
  coding: ["requirements", "design", "coding", "testing"],
  testing: ["requirements", "design", "coding", "testing", "deployment"],
  deployment: ["requirements", "design", "coding", "testing", "deployment", "operations"],
  operations: ["requirements", "design", "coding", "testing", "deployment"],
};

export function canTransitionPhase(from: WorkflowPhase, to: WorkflowPhase): boolean {
  return from !== to && (PHASE_TRANSITIONS[from]?.includes(to) ?? false);
}

export function assertTransition(from: WorkflowPhase, to: WorkflowPhase): void {
  if (!canTransitionPhase(from, to)) {
    throw new Error(
      `Illegal phase transition: ${from} -> ${to} (allowed: ${PHASE_TRANSITIONS[from]?.join(", ") ?? "none"})`,
    );
  }
}

export const PHASE_DESCRIPTIONS: Record<WorkflowPhase, string> = {
  requirements: "PM 正在澄清目标、边界、验收标准与安全要求。",
  design: "Architect 正在给出方案、接口契约、任务拆解与安全设计。",
  coding: "开发正在实现；Security 按检查点做 SCA、SAST 和代码审计。",
  testing: "QA 做测试与规格核对；Security 做安全测试和渗透验证。",
  deployment: "DevOps 准备预览、发布、健康检查与回滚。",
  operations: "服务持续运行；DevOps 处理监控、故障、补丁和下一轮迭代。",
};

export type PhaseGateContext = {
  artifacts: Array<{
    kind: string;
    status: string;
    title: string;
    updatedAt?: Date | string | null;
    acceptanceRefs?: string[] | null;
    commit?: string | null;
  }>;
  tasks: Array<{
    status: string;
    id?: string;
    mode?: string | null;
    evidence?: Record<string, unknown> | null;
    acceptanceRefs?: string[] | null;
    gateKey?: string | null;
    iterationId?: string | null;
  }>;
  approvals: Array<{ targetType: string; status: string }>;
  /** AC IDs the current iteration must deliver. */
  acceptanceIds?: string[] | null;
  /** Active iteration: task-based gates only count this iteration's tasks. */
  iterationId?: string | null;
  targetCommit?: string | null;
  /**
   * Evidence must belong to the current phase. Without this, an old accepted
   * test report or release check from a previous iteration can satisfy a new
   * gate and let the project race to operations without doing the work.
   */
  phaseEnteredAt?: Date | string | null;
};

export interface GateRequirement {
  key: string;
  label: string;
  met: boolean;
}

export function normalizeAcceptanceId(value: string): string | null {
  const match = /^AC\s*(\d+)([a-z]?)$/i.exec(value.trim());
  if (!match) return null;
  return `AC${match[1]}${(match[2] ?? "").toUpperCase()}`;
}

/** Pull AC IDs out of a PRD/acceptance document. */
export function extractAcceptanceIds(content: string): string[] {
  const found = new Set<string>();
  for (const match of content.matchAll(/\bAC\s?(\d+)([a-z]?)\b/gi)) {
    found.add(`AC${match[1]}${(match[2] ?? "").toUpperCase()}`);
  }
  return [...found];
}

/** ACs without any non-cancelled task that references them. */
export function missingAcceptanceCoverage(
  scope: string[],
  tasks: Array<{ status: string; acceptanceRefs?: string[] | null }>,
): string[] {
  if (!scope.length) return [];
  const normalized = scope.map(normalizeAcceptanceId).filter((id): id is string => Boolean(id));
  const covered = new Set(
    tasks
      .filter((task) => task.status !== "cancelled")
      .flatMap((task) => task.acceptanceRefs ?? [])
      .map(normalizeAcceptanceId)
      .filter((id): id is string => Boolean(id)),
  );
  return normalized.filter((id) => !covered.has(id));
}

/** ACs without accepted evidence that references them. */
export function missingEvidenceCoverage(
  scope: string[],
  artifacts: Array<{ status: string; acceptanceRefs?: string[] | null }>,
): string[] {
  if (!scope.length) return [];
  const normalized = scope.map(normalizeAcceptanceId).filter((id): id is string => Boolean(id));
  const covered = new Set(
    artifacts
      .filter((artifact) => artifact.status === "accepted")
      .flatMap((artifact) => artifact.acceptanceRefs ?? [])
      .map(normalizeAcceptanceId)
      .filter((id): id is string => Boolean(id)),
  );
  return normalized.filter((id) => !covered.has(id));
}

/** Requirements that must be satisfied before leaving `phase`. */
export function gateRequirements(phase: WorkflowPhase, ctx: PhaseGateContext): GateRequirement[] {
  const phaseStarted = ctx.phaseEnteredAt ? new Date(ctx.phaseEnteredAt).getTime() : 0;
  const hasAccepted = (kind: string) =>
    ctx.artifacts.some((artifact) => {
      if (artifact.kind !== kind || artifact.status !== "accepted") return false;
      if (!phaseStarted || !artifact.updatedAt) return true;
      // A small grace window covers evidence created in the same turn as the
      // phase transition; it is far shorter than a stale iteration.
      return new Date(artifact.updatedAt).getTime() >= phaseStarted - 5 * 60_000;
    });
  // A plan/design written before the latest PRD is stale: the scope may have
  // grown (for example a new v1.1 dashboard/admin requirement) while the old
  // plan still satisfies the gate. Acceptance-detail revisions made during
  // design/implementation must not invalidate the plan on every batch; the
  // PRD is the scope anchor.
  const latestSpecAt = ctx.artifacts
    .filter((artifact) => artifact.kind === "prd")
    .reduce((latest, artifact) => {
      if (!artifact.updatedAt) return latest;
      return Math.max(latest, new Date(artifact.updatedAt).getTime());
    }, 0);
  const hasAcceptedForSpec = (kind: string) =>
    ctx.artifacts.some((artifact) => {
      if (artifact.kind !== kind || artifact.status !== "accepted") return false;
      if (!latestSpecAt || !artifact.updatedAt) return true;
      return new Date(artifact.updatedAt).getTime() >= latestSpecAt - 5 * 60_000;
    });
  // A failed task that has already produced a defect successor is superseded:
  // the successor carries the rework, so the old task must not hold the gate
  // open forever. Explicit `supersededBy` markers are treated the same way.
  // Old iterations (and legacy tasks with no iteration) must not hold the
  // current iteration's coding gate open.
  const tasksInScope = ctx.iterationId
    ? ctx.tasks.filter((task) => task.iterationId === ctx.iterationId)
    : ctx.tasks;
  const superseded = new Set<string>();
  for (const task of tasksInScope) {
    const defectOf = task.evidence?.["defectOf"];
    if (typeof defectOf === "string") superseded.add(defectOf);
    if (typeof task.evidence?.["supersededBy"] === "string" && task.id) {
      superseded.add(task.id);
    }
  }
  const openTasks = tasksInScope.filter((t) => {
    if (t.status === "done" || t.status === "cancelled") return false;
    if (t.id && superseded.has(t.id)) return false;
    return true;
  });
  // Workbench tasks collect evidence for a gate; they are not coding work.
  // A pending release/security evidence task must not keep the coding gate
  // open after all implementation tasks are done.
  const openCodeTasks = openTasks.filter((task) => task.mode !== "workbench");

  switch (phase) {
    case "requirements":
      return [
        { key: "prd_accepted", label: "PRD 已生成并内部接受", met: hasAccepted("prd") },
        {
          key: "acceptance_criteria",
          label: "验收标准已生成并内部接受",
          met: hasAccepted("acceptance_criteria"),
        },
        {
          key: "security_requirements",
          label: "安全/合规要求已记录",
          met: hasAccepted("security_requirements"),
        },
      ];
    case "design":
      return [
        {
          key: "design_accepted",
          label: "技术方案已生成并内部接受",
          met: hasAcceptedForSpec("design"),
        },
        {
          key: "plan_accepted",
          label: "实施计划已生成并内部接受（须覆盖最新 PRD 范围）",
          met: hasAcceptedForSpec("plan"),
        },
        { key: "has_tasks", label: "至少拆出 1 个可执行任务", met: tasksInScope.length > 0 },
        {
          key: "scope_coverage",
          label: "每条验收标准都有对应任务",
          met:
            !ctx.acceptanceIds?.length ||
            missingAcceptanceCoverage(ctx.acceptanceIds, tasksInScope).length === 0,
        },
        {
          key: "security_design",
          label: "威胁模型 / 安全设计已完成",
          met: hasAccepted("security_design"),
        },
      ];
    case "coding":
      return [
        {
          key: "tasks_closed",
          label: "所有编码任务已完成或取消",
          met: tasksInScope.length > 0 && openCodeTasks.length === 0,
        },
        {
          key: "scope_coverage",
          label: "每条验收标准仍有对应任务",
          met:
            !ctx.acceptanceIds?.length ||
            missingAcceptanceCoverage(ctx.acceptanceIds, tasksInScope).length === 0,
        },
        { key: "sca", label: "SCA 依赖扫描已完成", met: hasAccepted("sca_report") },
        { key: "sast", label: "SAST 静态扫描已完成", met: hasAccepted("sast_report") },
        { key: "code_audit", label: "代码安全审计已完成", met: hasAccepted("code_audit") },
      ];
    case "testing":
      return [
        { key: "test_report", label: "测试报告已接受", met: hasAccepted("test_report") },
        {
          key: "spec_review",
          label: "规格核对已通过",
          met: hasAccepted("spec_review"),
        },
        {
          key: "security_test",
          label: "安全测试 / 渗透验证已完成",
          met: hasAccepted("security_test"),
        },
        {
          key: "acceptance_evidence",
          label: "每条验收标准都有已接受证据",
          met:
            !ctx.acceptanceIds?.length ||
            missingEvidenceCoverage(ctx.acceptanceIds, ctx.artifacts).length === 0,
        },
      ];
    case "deployment":
      return [
        {
          key: "release_security",
          label: "发布安全 / SBOM 检查已通过",
          met: hasAccepted("release_security"),
        },
        {
          key: "release_readiness",
          label: "每条验收标准都有发布证据，且证据对应当前目标提交",
          met:
            !ctx.acceptanceIds?.length ||
            missingEvidenceCoverage(ctx.acceptanceIds, ctx.artifacts).length === 0,
        },
      ];
    case "operations":
      return [];
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
  // Forward moves satisfy the current stage gate. Backward loops and new
  // iterations are allowed because they represent rework or a new request.
  if (phaseIndex(to) <= phaseIndex(from)) return [];
  return gateRequirements(from, ctx);
}

export function canAdvance(phase: WorkflowPhase, ctx: PhaseGateContext): boolean {
  if (!nextPhase(phase)) return false;
  return gateRequirements(phase, ctx).every((r) => r.met);
}

/**
 * Who owns and who may join each stage. The Lead remains the process
 * controller; the stage owner owns content quality.
 */
export const STAGE_POLICIES: Record<
  WorkflowPhase,
  {
    owner: string;
    participants: string[];
    consult: string[];
    silent: string[];
    security: "consult" | "active" | "scheduled" | "release";
  }
> = {
  requirements: {
    owner: "pm",
    participants: ["pm", "lead"],
    consult: ["architect", "qa", "security"],
    silent: ["frontend", "backend", "devops"],
    security: "consult",
  },
  design: {
    owner: "architect",
    participants: ["architect", "pm", "lead", "frontend", "backend", "security"],
    consult: ["qa", "devops"],
    silent: [],
    security: "active",
  },
  coding: {
    owner: "lead",
    participants: ["lead", "frontend", "backend", "devops"],
    consult: [],
    silent: ["pm", "architect", "qa", "security"],
    security: "scheduled",
  },
  testing: {
    owner: "qa",
    participants: ["qa", "frontend", "backend", "lead", "architect", "security"],
    consult: ["devops"],
    silent: ["pm"],
    security: "active",
  },
  deployment: {
    owner: "devops",
    participants: ["devops", "backend", "qa", "security", "lead"],
    consult: ["pm"],
    silent: ["frontend", "architect"],
    security: "release",
  },
  operations: {
    owner: "devops",
    participants: ["devops", "backend", "security", "qa", "lead"],
    consult: ["pm"],
    silent: ["frontend", "architect"],
    security: "active",
  },
};
