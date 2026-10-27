import { describe, expect, test } from "vitest";
import { isEngineeringTopic } from "@devteam/domain";

describe("client decision policy", () => {
  test("engineering execution details stay internal", () => {
    expect(isEngineeringTopic("41065 预览实例在走查结束后怎么处置？")).toBe(true);
    expect(isEngineeringTopic("seed 脚本的 baseUrl 和账号口令怎么注入？")).toBe(true);
    expect(isEngineeringTopic("谁来 revoke 演示 token？")).toBe(true);
    expect(isEngineeringTopic("QA 没有浏览器怎么点页面？")).toBe(true);
    expect(isEngineeringTopic("回滚演练用哪个 commit？")).toBe(true);
  });

  test("product decisions still go to the client", () => {
    expect(isEngineeringTopic("v1 是否支持附件上传？")).toBe(false);
    expect(isEngineeringTopic("这三个需求优先级怎么排？")).toBe(false);
    expect(isEngineeringTopic("验收标准是否接受？")).toBe(false);
    expect(isEngineeringTopic("产品范围要不要包含移动端？")).toBe(false);
  });
});
