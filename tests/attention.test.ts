import { describe, expect, test } from "vitest";
import { heuristicAttention, parseAttentionDecision } from "@devteam/agents";

describe("attention protocol", () => {
  test("parses PASS, SPEAK and JSON", () => {
    expect(parseAttentionDecision("PASS")).toEqual({ speak: false, reason: "pass" });
    expect(parseAttentionDecision("[PASS]")).toEqual({ speak: false, reason: "pass" });
    expect(parseAttentionDecision("这条消息与我无关").speak).toBe(false);
    expect(parseAttentionDecision("无需回应").speak).toBe(false);
    expect(parseAttentionDecision("SPEAK: AC-4 的幂等只覆盖 POST").speak).toBe(true);
    expect(parseAttentionDecision("SPEAK: AC-4 的幂等只覆盖 POST").reason).toContain("AC-4");
    expect(parseAttentionDecision('{"speak":false,"reason":"旁观"}').speak).toBe(false);
  });

  test("treats an off-protocol sentence as wanting to speak", () => {
    expect(parseAttentionDecision("我建议先确认权限矩阵再拆任务。").speak).toBe(true);
  });
});

describe("heuristic attention fallback", () => {
  test("the phase owner speaks even without keywords", () => {
    expect(heuristicAttention("architect", "随便聊聊", "Architect", "design").speak).toBe(true);
    expect(heuristicAttention("pm", "先说说", "PM", "discovery").speak).toBe(true);
  });

  test("role keywords trigger a response", () => {
    expect(heuristicAttention("qa", "测试一下权限模型", "QA", "build").speak).toBe(true);
    expect(heuristicAttention("security", "这里有没有越权风险", "Security", "build").speak).toBe(true);
  });

  test("an unrelated role stays silent", () => {
    expect(heuristicAttention("frontend", "数据库迁移怎么做", "Frontend", "build").speak).toBe(false);
  });

  test("@ mention forces attention", () => {
    expect(heuristicAttention("security", "@security 看下这个接口", "Security", "build").speak).toBe(true);
  });

  test("an explicit request for everyone wakes the room", () => {
    expect(heuristicAttention("frontend", "大家都说说自己的看法", "Frontend", "build").speak).toBe(true);
  });

  test("an agent that already spoke stays silent unless named", () => {
    expect(heuristicAttention("pm", "继续讨论需求", "PM", "discovery", 1).speak).toBe(false);
    expect(heuristicAttention("pm", "@pm 再看一下", "PM", "discovery", 1).speak).toBe(true);
  });
});
