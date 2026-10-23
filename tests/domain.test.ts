import { describe, expect, test } from "vitest";
import { canTransitionTask, gateRequirements, nextPhase, parseAgentOutput } from "@devteam/domain";

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

  test("discovery needs an accepted PRD and acceptance criteria", () => {
    expect(gateRequirements("discovery", empty).every((r) => !r.met)).toBe(true);
    const met = gateRequirements("discovery", {
      artifacts: [
        { kind: "prd", status: "accepted", title: "PRD" },
        { kind: "acceptance_criteria", status: "accepted", title: "AC" },
      ],
      tasks: [],
      approvals: [],
    });
    expect(met.every((r) => r.met)).toBe(true);
  });

  test("planning requires the current accepted spec and at least one task", () => {
    const missing = gateRequirements("planning", {
      artifacts: [],
      tasks: [{ status: "ready" }],
      approvals: [],
    });
    expect(missing.filter((r) => !r.met).map((r) => r.key)).toEqual([
      "current_prd",
      "current_acceptance",
    ]);

    const ok = gateRequirements("planning", {
      artifacts: [
        { kind: "prd", status: "accepted", title: "PRD" },
        { kind: "acceptance_criteria", status: "accepted", title: "AC" },
      ],
      tasks: [{ status: "ready" }],
      approvals: [],
    });
    expect(ok.every((r) => r.met)).toBe(true);
  });

  test("build waits for every task to close", () => {
    const open = gateRequirements("build", {
      artifacts: [],
      tasks: [{ status: "done" }, { status: "in_progress" }],
      approvals: [],
    });
    expect(open[0]?.met).toBe(false);
    const closed = gateRequirements("build", {
      artifacts: [],
      tasks: [{ status: "done" }, { status: "cancelled" }],
      approvals: [],
    });
    expect(closed[0]?.met).toBe(true);
  });

  test("phases advance one step at a time", () => {
    expect(nextPhase("intake")).toBe("discovery");
    expect(nextPhase("deliver")).toBe("done");
    expect(nextPhase("done")).toBeNull();
  });
});
