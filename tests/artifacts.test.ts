import { describe, expect, test } from "vitest";
import { canonicalArtifactKey, initialArtifactStatus } from "@devteam/domain";

describe("artifact identity", () => {
  test("PRD / acceptance criteria / design / plan are one document each", () => {
    expect(canonicalArtifactKey("prd", "Team Pulse 后端 PRD（v1 草案）")).toBe("prd");
    expect(canonicalArtifactKey("prd", "Team Pulse PRD v4（count 口径定稿）")).toBe("prd");
    expect(canonicalArtifactKey("acceptance_criteria", "验收标准 v5（定稿）")).toBe(
      "acceptance_criteria",
    );
    expect(canonicalArtifactKey("design", "Team Pulse 技术设计 v1")).toBe("design");
    expect(canonicalArtifactKey("plan", "Team Pulse 实施计划 v1")).toBe("plan");
  });

  test("only product intent waits for the client", () => {
    expect(initialArtifactStatus("prd")).toBe("in_review");
    expect(initialArtifactStatus("acceptance_criteria")).toBe("in_review");
    expect(initialArtifactStatus("design")).toBe("accepted");
    expect(initialArtifactStatus("api_contract")).toBe("accepted");
    expect(initialArtifactStatus("plan")).toBe("accepted");
    expect(initialArtifactStatus("diff")).toBe("accepted");
    expect(initialArtifactStatus("test_report")).toBe("accepted");
    expect(initialArtifactStatus("spec_review")).toBe("accepted");
  });

  test("contracts with the same base title share a key", () => {
    expect(canonicalArtifactKey("api_contract", "Team Pulse HTTP API 契约 v1")).toBe(
      canonicalArtifactKey("api_contract", "Team Pulse HTTP API 契约 v2"),
    );
  });

  test("different contracts, diffs and task reports stay separate", () => {
    expect(canonicalArtifactKey("api_contract", "Team Pulse 双层契约 v2")).not.toBe(
      canonicalArtifactKey("api_contract", "Team Pulse HTTP API 契约 v2"),
    );
    expect(canonicalArtifactKey("diff", "变更：任务 A")).not.toBe(
      canonicalArtifactKey("diff", "变更：任务 B"),
    );
  });
});
