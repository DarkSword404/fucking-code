import { describe, expect, test } from "vitest";
import {
  canTransitionPhase,
  canTransitionTask,
  gateRequirements,
  gateRequirementsForTransition,
  nextPhase,
  parseAgentOutput,
} from "@devteam/domain";

describe("agent action protocol", () => {
  test("repairs raw newlines and quotes inside artifact content", () => {
    const raw = `方案如下。

\`\`\`devteam
{"actions":[
 {"type":"create_artifact","kind":"design","title":"测试方案","summary":"含裸换行","content":"# 标题
第一行
第二行，带 "引号" 和 'single'
"},
 {"type":"ask_user","question":"这样可以吗？"}
]}
\`\`\``;

    const parsed = parseAgentOutput(raw);
    expect(parsed.errors).toEqual([]);
    expect(parsed.text).toBe("方案如下。");
    expect(parsed.actions.map((a) => a.type)).toEqual(["create_artifact", "ask_user"]);
    const artifact = parsed.actions[0] as unknown as { content: string };
    expect(artifact.content.split("\n").length).toBeGreaterThan(3);
  });

  test("accepts a bare array and a tasks array", () => {
    const bare = parseAgentOutput('```devteam\n[{"type":"ask_user","question":"Q"}]\n```');
    expect(bare.actions).toHaveLength(1);

    const tasks = parseAgentOutput(
      '```devteam\n{"tasks":[{"title":"T1","description":"D","role":"backend","acceptance":["A"]}]}\n```',
    );
    expect(tasks.actions[0]).toMatchObject({ type: "create_task", title: "T1" });
  });

  test("rejects an unknown action without throwing", () => {
    const parsed = parseAgentOutput('```devteam\n{"actions":[{"type":"drop_database"}]}\n```');
    expect(parsed.actions).toHaveLength(0);
    expect(parsed.errors.length).toBeGreaterThan(0);
  });

  test("parses a client-confirmed phase proposal", () => {
    const parsed = parseAgentOutput(
      '```devteam\n{"actions":[{"type":"request_phase","phase":"coding","reason":"设计已确认，任务已拆好"}]}\n```',
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.actions[0]).toMatchObject({
      type: "request_phase",
      phase: "coding",
      reason: "设计已确认，任务已拆好",
    });
  });

  test("accepts long-term memory candidates", () => {
    const parsed = parseAgentOutput(
      '```devteam\n{"actions":[{"type":"remember","kind":"constraint","title":"日期格式","content":"统一使用 ISO 日期"}]}\n```',
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.actions[0]).toMatchObject({
      type: "remember",
      kind: "constraint",
      title: "日期格式",
    });
  });
});

describe("task state machine", () => {
  test("allows the normal path and rejects skips", () => {
    expect(canTransitionTask("ready", "in_progress")).toBe(true);
    expect(canTransitionTask("in_progress", "review")).toBe(true);
    expect(canTransitionTask("review", "done")).toBe(true);
    expect(canTransitionTask("ready", "done")).toBe(false);
    expect(canTransitionTask("done", "in_progress")).toBe(false);
  });
});

describe("workflow gates", () => {
  const empty = { artifacts: [], tasks: [], approvals: [] };

  test("requirements needs PRD, acceptance and security requirements", () => {
    expect(gateRequirements("requirements", empty).every((r) => !r.met)).toBe(true);
    const met = gateRequirements("requirements", {
      artifacts: [
        { kind: "prd", status: "accepted", title: "PRD" },
        { kind: "acceptance_criteria", status: "accepted", title: "AC" },
        { kind: "security_requirements", status: "accepted", title: "SEC" },
      ],
      tasks: [],
      approvals: [],
    });
    expect(met.every((r) => r.met)).toBe(true);
  });

  test("design needs design, plan, tasks and security design", () => {
    const missing = gateRequirements("design", empty);
    expect(missing.filter((r) => !r.met).map((r) => r.key)).toEqual([
      "design_accepted",
      "plan_accepted",
      "has_tasks",
      "security_design",
    ]);
    const ok = gateRequirements("design", {
      artifacts: [
        { kind: "design", status: "accepted", title: "Design" },
        { kind: "plan", status: "accepted", title: "Plan" },
        { kind: "security_design", status: "accepted", title: "Threat model" },
      ],
      tasks: [{ status: "ready" }],
      approvals: [],
    });
    expect(ok.every((r) => r.met)).toBe(true);
  });

  test("coding waits for tasks and security evidence", () => {
    const open = gateRequirements("coding", {
      artifacts: [],
      tasks: [{ status: "done" }, { status: "in_progress" }],
      approvals: [],
    });
    expect(open[0]?.met).toBe(false);
    const closed = gateRequirements("coding", {
      artifacts: [
        { kind: "sca_report", status: "accepted", title: "SCA" },
        { kind: "sast_report", status: "accepted", title: "SAST" },
        { kind: "code_audit", status: "accepted", title: "Audit" },
      ],
      tasks: [{ status: "done" }, { status: "cancelled" }],
      approvals: [],
    });
    expect(closed.every((r) => r.met)).toBe(true);
  });

  test("a failed task superseded by a defect does not deadlock the coding gate", () => {
    const artifacts = [
      { kind: "sca_report", status: "accepted", title: "SCA" },
      { kind: "sast_report", status: "accepted", title: "SAST" },
      { kind: "code_audit", status: "accepted", title: "Audit" },
    ];
    const evaluating = gateRequirements("coding", {
      artifacts,
      tasks: [
        { id: "failed-1", status: "failed" },
        { id: "defect-1", status: "in_progress", evidence: { defectOf: "failed-1" } },
      ],
      approvals: [],
    });
    expect(evaluating.find((r) => r.key === "tasks_closed")?.met).toBe(false);

    const repaired = gateRequirements("coding", {
      artifacts,
      tasks: [
        { id: "failed-1", status: "failed" },
        { id: "defect-1", status: "done", evidence: { defectOf: "failed-1" } },
      ],
      approvals: [],
    });
    expect(repaired.every((r) => r.met)).toBe(true);

    const explicit = gateRequirements("coding", {
      artifacts,
      tasks: [
        { id: "old", status: "failed", evidence: { supersededBy: "other-task" } },
        { id: "other", status: "done" },
      ],
      approvals: [],
    });
    expect(explicit.every((r) => r.met)).toBe(true);
  });

  test("six-stage forward chain and persistent operations", () => {
    expect(nextPhase("requirements")).toBe("design");
    expect(nextPhase("design")).toBe("coding");
    expect(nextPhase("coding")).toBe("testing");
    expect(nextPhase("testing")).toBe("deployment");
    expect(nextPhase("deployment")).toBe("operations");
    expect(nextPhase("operations")).toBeNull();
  });

  test("supports rework and new-iteration loops", () => {
    expect(canTransitionPhase("design", "coding")).toBe(true);
    expect(canTransitionPhase("testing", "coding")).toBe(true);
    expect(canTransitionPhase("testing", "design")).toBe(true);
    expect(canTransitionPhase("deployment", "testing")).toBe(true);
    expect(canTransitionPhase("operations", "requirements")).toBe(true);
    expect(canTransitionPhase("operations", "deployment")).toBe(true);
    expect(canTransitionPhase("requirements", "deployment")).toBe(false);
    expect(canTransitionPhase("coding", "coding")).toBe(false);
  });

  test("forward transitions keep the gate, rework loops do not", () => {
    const missing = gateRequirementsForTransition("requirements", "design", empty);
    expect(missing.some((r) => !r.met)).toBe(true);
    expect(gateRequirementsForTransition("testing", "coding", empty)).toEqual([]);
    expect(gateRequirementsForTransition("deployment", "coding", empty)).toEqual([]);
    expect(gateRequirementsForTransition("operations", "requirements", empty)).toEqual([]);
  });
});
