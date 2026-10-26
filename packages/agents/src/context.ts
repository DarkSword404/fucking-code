import type { WorkflowPhase } from "@devteam/contracts";
import type { RoomBundle } from "@devteam/db";
import { ACTION_PROTOCOL, PHASE_DESCRIPTIONS, PHASE_TRANSITIONS, phaseIndex } from "@devteam/domain";

const ALIASES: Record<string, string> = {
  pm: "pm",
  产品: "pm",
  产品经理: "pm",
  architect: "architect",
  架构: "architect",
  架构师: "architect",
  frontend: "frontend",
  前端: "frontend",
  backend: "backend",
  后端: "backend",
  qa: "qa",
  测试: "qa",
  lead: "lead",
  负责人: "lead",
  队长: "lead",
  security: "security",
  安全: "security",
};

export function normalizeMention(raw: string): string | null {
  const key = raw.trim().replace(/^@/, "").toLowerCase();
  return ALIASES[key] ?? null;
}

export function extractMentions(content: string): string[] {
  const found: string[] = [];
  for (const match of content.matchAll(/@([A-Za-z\u4e00-\u9fa5]+)/g)) {
    const role = normalizeMention(match[1] ?? "");
    if (role && !found.includes(role)) found.push(role);
  }
  return found;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n…（已截断，共 ${value.length} 字）`;
}

export function buildSystemPrompt(bundle: RoomBundle, roleKey: string): string {
  const role = bundle.roles.find((r) => r.key === roleKey);
  if (!role) throw new Error(`unknown role: ${roleKey}`);
  const phase = bundle.project.phase as WorkflowPhase;
  return [
    role.systemPrompt,
    "",
    ACTION_PROTOCOL,
    "",
    `当前项目阶段：${phase}（${PHASE_DESCRIPTIONS[phase]}）`,
    `阶段序号：${phaseIndex(phase) + 1}/9`,
    `当前阶段可提议的转移：${PHASE_TRANSITIONS[phase].filter((p) => p !== phase).join("、")}`,
    "阶段由你根据证据主动判断，但进入、回退或开始新一轮都必须用 request_phase 让甲方确认。",
    "你是团队里的一个具体员工，不是通用助手。不要越权替别的岗位做决定。",
    "用户是甲方/客户，你和团队是乙方。尊重甲方，但不要无条件服从：需求不清先问，方案有风险或更优解时直接说明并给出替代方案。",
  ].join("\n");
}

export function buildPrompt(
  bundle: RoomBundle,
  roleKey: string,
  trigger: { senderName: string; content: string },
  userName: string,
  round: number,
  participantKeys?: Set<string>,
  repoContext?: string,
): string {
  const role = bundle.roles.find((r) => r.key === roleKey);
  const phase = bundle.project.phase as WorkflowPhase;
  const latestByArtifact = new Map<string, (typeof bundle.versions)[number]>();
  for (const version of bundle.versions) {
    if (!latestByArtifact.has(version.artifactId)) latestByArtifact.set(version.artifactId, version);
  }

  const recent = bundle.messages
    .slice(-20)
    .map(
      (m) =>
        `[${m.senderType === "user" ? "甲方" : m.senderName}] ${truncate(
          m.content.replace(/\s+/g, " "),
          m.senderType === "agent" ? 1800 : 700,
        )}`,
    )
    .join("\n");

  const taskLines = bundle.tasks
    .slice(0, 24)
    .map((t) => `- [${t.status}] ${t.title}${t.roleKey ? ` @${t.roleKey}` : ""}${t.blockedReason ? `（阻塞：${t.blockedReason}）` : ""}`)
    .join("\n");

  const artifactLines = bundle.artifacts
    .map((a) => {
      const v = latestByArtifact.get(a.id);
      return `- [${a.kind}/${a.status}] ${a.title}：${v?.summary || "（无摘要）"}`;
    })
    .join("\n");

  const importantArtifacts = bundle.artifacts
    .filter((a) => ["prd", "acceptance_criteria", "design", "api_contract", "test_report"].includes(a.kind))
    .map((a) => {
      const v = latestByArtifact.get(a.id);
      if (!v) return "";
      return `### ${a.title}（${a.kind}, v${v.version}, ${a.status}）\n${truncate(v.content, 2600)}`;
    })
    .filter(Boolean)
    .join("\n\n");

  const memoryLines = bundle.memories
    .map((memory) => `- [${memory.type}] ${memory.title}：${truncate(memory.content, 600)}`)
    .join("\n");

  const pendingApprovals = bundle.approvals
    .filter((a) => a.status === "pending")
    .map((a) => `- ${a.title}（${a.targetType}）`)
    .join("\n");

  const openDecisions = bundle.decisions
    .filter((d) => d.status === "proposed")
    .map((d) => `- ${d.title}：${truncate(d.rationale, 200)}`)
    .join("\n");

  const roster = bundle.roles
    .filter((r) => r.enabled && (!participantKeys || participantKeys.has(r.key)))
    .map((r) => `@${r.key} = ${r.displayName}（${r.description}）`)
    .join("\n");

  return [
    `## 项目`,
    `名称：${bundle.project.name}`,
    `描述：${bundle.project.description || "（暂无）"}`,
    `当前阶段：${phase} — ${PHASE_DESCRIPTIONS[phase]}`,
    `甲方/客户：${userName}`,
    "",
    `## 团队名册（本次房间成员）`,
    roster,
    "房间外的人不会看到这条消息；需要他们介入时可以 @ 对方，系统会把他加入本次讨论。",
    "",
    "## 协作方式",
    "- 当前是单发言人模式：每次只有一个人回复，其他同事看到后再决定是否接话。",
    "- 你是乙方团队的一员，只代表自己的岗位发言，不要替同事回答。",
    "- 信息不足时先问 1-3 个真正影响方案的问题，不要猜；需要甲方拍板或补充信息时使用 ask_user，发出问题后本轮会停下来等待。",
    "- 需要同事的专业输入时 @对方 或 handoff，说清楚你需要他回答什么。",
    "- 可以反驳甲方，但必须给出理由、风险、替代方案和你的推荐，不要为了迎合而答应。",
    repoContext ? `\n## 仓库上下文\n${truncate(repoContext, 12000)}` : "",
    "",
    `## 最近对话`,
    recent || "（这是第一条消息）",
    "",
    `## 当前任务`,
    taskLines || "（还没有任务）",
    "",
    `## 已有产物`,
    artifactLines || "（还没有产物）",
    importantArtifacts ? `\n## 关键产物内容\n${importantArtifacts}` : "",
    memoryLines ? `\n## 项目长期记忆（已接受）\n${memoryLines}` : "",
    "",
    `## 待人工审批`,
    pendingApprovals || "（无）",
    "",
    `## 待确认决策`,
    openDecisions || "（无）",
    "",
    `## 最新动态（第 ${round + 1} 轮）`,
    `${trigger.senderName}：${truncate(trigger.content, 4000)}`,
    "",
    `你已经判断这条动态需要你（${role?.displayName ?? roleKey}）发言。直接回应，不要解释你为什么发言。`,
    "这是一个共享聊天室，所有同事都能看到；不要复述别人说过的内容。",
    "只在你这个岗位的职责范围内说话；需要其他角色介入时用 handoff 或 @对方。",
    "如果你同意某人，直接补充或推进，不要重复表态。信息不足时最多问 3 个关键问题，不要一次列一长串。",
    "不要急着一次性做完所有事。先用多轮对话确认目标、用户、场景、边界和验收，再进入方案或实现。",
    "如果甲方的要求会导致明显风险、范围失控或更差的体验，直接反驳并给一个更小/更稳的替代方案。",
  ]
    .filter((line) => line !== "")
    .join("\n");
}
