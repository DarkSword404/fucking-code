import type { WorkflowPhase } from "@devteam/contracts";
import type { RoomBundle } from "@devteam/db";
import { PHASE_DESCRIPTIONS, STAGE_POLICIES } from "@devteam/domain";

export interface AttentionDecision {
  speak: boolean;
  reason: string;
}

export interface RoomTrigger {
  senderName: string;
  content: string;
}

const PHASE_OWNER: Record<string, string> = {
  requirements: "pm",
  design: "architect",
  coding: "lead",
  testing: "qa",
  deployment: "devops",
  operations: "devops",
};

const ROLE_KEYWORDS: Record<string, RegExp> = {
  pm: /需求|prd|用户|场景|范围|验收|产品|目标|优先级/i,
  architect: /架构|方案|设计|接口|契约|数据模型|技术选型|扩展|性能|一致性/i,
  frontend: /前端|ui|页面|交互|组件|样式|可访问|动画|表单/i,
  backend: /后端|api|数据库|服务|事务|幂等|迁移|队列|缓存/i,
  qa: /测试|质量|用例|回归|缺陷|验证|覆盖|边界/i,
  security: /安全|权限|越权|密钥|漏洞|注入|xss|csrf|供应链/i,
  devops: /部署|运维|发布|回滚|环境|容器|docker|k8s|nginx|监控|日志|预览|健康检查/i,
  lead: /计划|拆解|拆任务|排期|推进|阻塞|协调|依赖|谁来做/i,
};

/**
 * Parse the attention decision. Models occasionally ignore the protocol and
 * return a normal sentence; in that case we treat it as "wants to speak"
 * rather than silently dropping the turn.
 */
export function parseAttentionDecision(raw: string): AttentionDecision {
  const cleaned = raw
    .trim()
    .replace(/^[\s[【（(]+|[\s\]】）)]+$/g, "")
    .trim();
  if (!cleaned) return { speak: false, reason: "empty response" };

  try {
    const parsed = JSON.parse(cleaned) as { speak?: unknown; reason?: unknown };
    if (typeof parsed.speak === "boolean") {
      return { speak: parsed.speak, reason: String(parsed.reason ?? "") };
    }
  } catch {
    // not JSON
  }

  if (/^(pass|silent|skip|no[_\s-]?reply)\b/i.test(cleaned)) {
    return { speak: false, reason: "pass" };
  }
  const speak = cleaned.match(/^speak\s*[:：]\s*([\s\S]*)$/i);
  if (speak) {
    return { speak: true, reason: (speak[1] ?? "").trim().slice(0, 300) || "speak" };
  }
  if (/\bPASS\b/i.test(cleaned) && !/\bSPEAK\b/i.test(cleaned)) {
    return { speak: false, reason: "pass" };
  }
  if (
    /^(沉默|不发言|无需发言|与我无关|不相关|不需要我|不参与)/.test(cleaned) ||
    /(无需|不需要|不用).{0,6}(回应|发言)/.test(cleaned) ||
    /与我无关|不相关/.test(cleaned)
  ) {
    return { speak: false, reason: cleaned.slice(0, 200) };
  }
  return { speak: true, reason: cleaned.slice(0, 300) };
}

/**
 * Deterministic fallback used by the mock runtime and when the attention model
 * is unavailable. It is deliberately conservative: a role only speaks when the
 * message touches its domain, it owns the current phase, or it was named.
 */
export function heuristicAttention(
  roleKey: string,
  content: string,
  roleName: string,
  phase: WorkflowPhase,
  spokenCount = 0,
): AttentionDecision {
  // Round triggers include "[PM] ..." prefixes so the model knows who spoke.
  // Strip them before keyword/name matching, otherwise every role sees its own
  // name in the transcript and thinks it was mentioned.
  const clean = content.replace(
    /\[(?:PM|Architect|Frontend|Backend|QA|Security|Lead|团队)\]\s*/gi,
    "",
  );
  if (/所有人|大家|全员|每个人都|都说说|各自|每位/.test(clean)) {
    return { speak: true, reason: "用户要求全员参与" };
  }
  if (clean.toLowerCase().includes(`@${roleKey}`)) {
    return { speak: true, reason: "被 @ 点名" };
  }
  if (spokenCount > 0) {
    return { speak: false, reason: "本轮已经发过言，除非被 @ 否则不再重复" };
  }
  if (clean.toLowerCase().includes(roleName.toLowerCase())) {
    return { speak: true, reason: "消息提到了这个岗位" };
  }
  if (PHASE_OWNER[phase] === roleKey) {
    return { speak: true, reason: `当前阶段的负责人（${phase}）` };
  }
  const keyword = ROLE_KEYWORDS[roleKey];
  if (keyword?.test(clean)) {
    return { speak: true, reason: "消息涉及该岗位职责" };
  }
  return { speak: false, reason: "与当前岗位无关" };
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

export function buildAttentionPrompt(
  bundle: RoomBundle,
  roleKey: string,
  trigger: RoomTrigger,
  spokenCount = 0,
  participantKeys?: Set<string>,
  repoContext?: string,
): string {
  const role = bundle.roles.find((r) => r.key === roleKey);
  if (!role) throw new Error(`unknown role: ${roleKey}`);
  const phase = bundle.project.phase as WorkflowPhase;
  const stagePolicy = STAGE_POLICIES[phase];

  const roster = bundle.roles
    .filter((r) => r.enabled && (!participantKeys || participantKeys.has(r.key)))
    .map((r) => `@${r.key}（${r.displayName}）`)
    .join("、");

  const transcript = bundle.messages
    .slice(-14)
    .map(
      (m) =>
        `[${m.senderType === "user" ? "甲方" : m.senderName}] ${truncate(
          m.content.replace(/\s+/g, " "),
          420,
        )}`,
    )
    .join("\n");

  return [
    `你是 ${role.displayName}（@${role.key}）。${role.description}`,
    `你在一个共享项目聊天室里，能看到所有消息；你不需要对每条消息都回应。`,
    "用户是甲方/客户，你和团队是乙方。需求不明确时应当提问，方案有风险时要指出；不要为了迎合而假装确定。",
    "当前是单发言人模式：每次只有一个人回复，其他人下一轮再判断。",
    "",
    `项目：${bundle.project.name}`,
    `项目描述：${truncate(bundle.project.description || "（暂无）", 600)}`,
    `当前阶段：${phase} — ${PHASE_DESCRIPTIONS[phase]}`,
    `阶段主责：${stagePolicy.owner}；正常参与：${stagePolicy.participants.join("、")}；咨询：${stagePolicy.consult.join("、") || "无"}；默认静默：${stagePolicy.silent.join("、") || "无"}。`,
    stagePolicy.silent.includes(role.key)
      ? "你在这个阶段默认不发言。只有被 @、收到 handoff、或用户明确点名时才介入。"
      : "",
    `本次房间成员：${roster || "（只有你）"}`,
    "房间外的人不会看到这条消息。",
    repoContext ? `\n## 仓库上下文\n${truncate(repoContext, 6000)}` : "",
    "",
    "## 最近对话",
    transcript || "（这是第一条消息）",
    "",
    "## 最新动态",
    `${trigger.senderName}：${truncate(trigger.content, 2400)}`,
    "",
    "## 你的判断",
    `这条最新动态是否应该由你（${role.displayName}）来回应？`,
    "- 直接涉及你的岗位职责、你被 @、你能提供别人没有的关键信息 → 回应。",
    "- 最新动态里需求不清楚、范围有风险、或需要你的专业判断 → 回应并提出具体问题/建议。",
    "- 如果你同意、只是旁观、别人已经覆盖了你的观点、或与你无关 → 沉默。",
    "- 不要为了参与而发言；不要复述已经说过的内容。",
    "- 如果用户明确要求所有人发言，则回应。",
    spokenCount > 0
      ? `- 你本轮已经发过 ${spokenCount} 次言。除非这条新消息直接需要你补充或纠正，否则沉默。`
      : "",
    "",
    "只输出一行，不要解释：",
    "PASS",
    "或",
    "SPEAK: <一句话理由>",
  ].join("\n");
}
