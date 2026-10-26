import { opencodeFetch } from "@devteam/agents";

export interface VerificationCheck {
  criterion: string;
  status: "pass" | "fail" | "unverified";
  evidence: string;
}

export interface VerificationResult {
  verdict: "pass" | "fail" | "unverified";
  checks: VerificationCheck[];
  missing: string[];
  raw: string;
}

export function parseVerification(raw: string): VerificationResult {
  const text = raw.trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return {
      verdict: "unverified",
      checks: [],
      missing: ["规格核对返回的不是合法 JSON"],
      raw: text.slice(0, 2000),
    };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return {
      verdict: "unverified",
      checks: [],
      missing: ["规格核对返回的 JSON 无法解析"],
      raw: text.slice(0, 2000),
    };
  }

  const verdict =
    parsed.verdict === "pass" || parsed.verdict === "fail" ? parsed.verdict : "unverified";
  const checks: VerificationCheck[] = Array.isArray(parsed.checks)
    ? parsed.checks
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
        .map((item) => ({
          criterion: String(item.criterion ?? "未命名检查项"),
          status:
            item.status === "pass" || item.status === "fail" ? item.status : "unverified",
          evidence: String(item.evidence ?? ""),
        }))
    : [];
  const missing = Array.isArray(parsed.missing)
    ? parsed.missing.map((item) => String(item)).slice(0, 12)
    : [];

  return { verdict, checks, missing, raw: text.slice(0, 2000) };
}

export async function verifyWork(input: {
  taskTitle: string;
  taskDescription: string;
  taskAcceptance: string[];
  spec: string;
  diff: string;
  testOutput: string;
  workspaceContext?: string;
  model?: { providerID: string; id: string } | null;
}): Promise<VerificationResult> {
  const model = input.model ?? {
    providerID: process.env.AGENT_MODEL_PROVIDER ?? "opencode-go",
    id: process.env.AGENT_MODEL_ID ?? "deepseek-v4.1-flash",
  };

  const maxDiffChars = Number(process.env.VERIFY_MAX_DIFF_CHARS ?? 120_000);
  const maxSectionChars = Number(process.env.VERIFY_MAX_DIFF_SECTION_CHARS ?? 60_000);
  const maxTestChars = Number(process.env.VERIFY_MAX_TEST_OUTPUT_CHARS ?? 30_000);
  const maxSpecChars = Number(process.env.VERIFY_MAX_SPEC_CHARS ?? 30_000);
  const sections = input.diff.split(/^(?=diff --git )/m).filter(Boolean);
  const diffParts: string[] = [];
  let diffChars = 0;
  for (const section of sections) {
    const capped =
      section.length > maxSectionChars
        ? `${section.slice(0, maxSectionChars)}\n... (file diff truncated)`
        : section;
    if (diffChars + capped.length > maxDiffChars) {
      diffParts.push("... (remaining diff files omitted; see the diff artifact)");
      break;
    }
    diffParts.push(capped);
    diffChars += capped.length;
  }
  const diffDigest = diffParts.length ? diffParts.join("\n") : "(no code changes)";

  const prompt = [
    "你是 QA。请严格核对这次代码变更是否满足给定的验收标准和接口契约。",
    "只输出一个 JSON 对象，不要 Markdown 代码块：",
    '{"verdict":"pass"|"fail"|"unverified","checks":[{"criterion":"...","status":"pass"|"fail"|"unverified","evidence":"..."}],"missing":["..."]}',
    "",
    "规则：",
    "1. 测试通过不代表规格满足；必须逐条对照本任务验收标准。",
    "2. 没有证据的检查项标 unverified，不要猜。",
    "3. verdict 只根据“本任务验收标准”和任务描述判定；完整规格里未被本任务覆盖的项标 unverified，evidence 写 \"out of scope for this task\"，不要让它们单独导致 fail。",
    "4. 任何本任务必须项 fail 或 unverified，verdict 不能是 pass。",
    "5. 只根据下面的规格、Diff 和测试输出判断，不要补充不存在的事实。",
    "6. “未列在变更文件中的文件”表示与基线一致，不需要看到 diff 才能判定零改动。",
    "",
    `## 任务\n${input.taskTitle}\n${input.taskDescription}`,
    `## 本任务验收标准（判定依据）\n${
      input.taskAcceptance.length
        ? input.taskAcceptance.map((item) => `- ${item}`).join("\n")
        : "（没有单独列出，按任务描述判定）"
    }`,
    `## 完整已确认规格（上下文，不要求本任务全部实现）\n${input.spec.slice(0, maxSpecChars)}`,
    `## 工作区变更文件\n${input.workspaceContext ?? "(unknown)"}`,
    `## Diff\n${diffDigest}`,
    `## 测试输出\n${input.testOutput.slice(0, maxTestChars)}`,
  ].join("\n");

  const response = await opencodeFetch<{ data?: { text?: string } }>(
    "/api/experimental/generate",
    {
      method: "POST",
      body: JSON.stringify({ prompt, model }),
      timeoutMs: Number(process.env.VERIFY_TIMEOUT_MS ?? 240_000),
    },
  );

  if (!response.ok) {
    return {
      verdict: "unverified",
      checks: [],
      missing: [`规格核对调用失败（${response.status}）`],
      raw: response.raw.slice(0, 2000),
    };
  }

  const text = (response.data as { data?: { text?: string } } | null)?.data?.text ?? "";
  return parseVerification(text);
}
