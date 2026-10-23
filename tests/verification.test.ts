import { describe, expect, test } from "vitest";
import { parseVerification } from "@devteam/workspace";

describe("spec verification parser", () => {
  test("parses a pass verdict with checks", () => {
    const result = parseVerification(
      '```json\n{"verdict":"pass","checks":[{"criterion":"count is unique members","status":"pass","evidence":"test A"}],"missing":[]}\n```',
    );
    expect(result.verdict).toBe("pass");
    expect(result.checks[0]?.criterion).toContain("unique");
  });

  test("parses a fail verdict and missing items", () => {
    const result = parseVerification(
      '{"verdict":"fail","checks":[{"criterion":"entryCount","status":"fail","evidence":"not found"}],"missing":["entryCount missing"]}',
    );
    expect(result.verdict).toBe("fail");
    expect(result.missing).toEqual(["entryCount missing"]);
  });

  test("invalid output fails closed as unverified", () => {
    const result = parseVerification("测试通过了，应该没问题。");
    expect(result.verdict).toBe("unverified");
    expect(result.missing.length).toBeGreaterThan(0);
  });
});
