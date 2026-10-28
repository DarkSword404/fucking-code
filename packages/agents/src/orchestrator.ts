import { eq } from "drizzle-orm";
import {
  EVENT_TYPES,
  type MessageType,
  type TurnSummary,
  type WorkflowPhase,
} from "@devteam/contracts";
import { agentRuns, captureAcceptedSpec, getDb, insertMessage, latestArtifactContent, loadRoomBundle, messages, projects, type RoleRow, type RoomBundle } from "@devteam/db";
import { STAGE_POLICIES, isEngineeringTopic, uuidv7, type ValidatedAgentAction } from "@devteam/domain";
import { applyActions, type EmitFn } from "./actions.js";
import {
  buildAttentionPrompt,
  heuristicAttention,
  type RoomTrigger,
} from "./attention.js";
import { buildPrompt, buildSystemPrompt, extractMentions, normalizeMention } from "./context.js";
import type { AgentRuntime } from "./runtime.js";

export interface OrchestratorParams {
  projectId: string;
  roomId: string;
  userMessageId: string;
  content: string;
  mentions?: string[];
  participantKeys?: string[];
  repoContext?: string;
  userId: string;
  userName: string;
  triggerLabel?: string;
  readOnly?: boolean;
  /** Only allow phase proposals; used by the phase steward turn. */
  phaseOnly?: boolean;
  signal?: AbortSignal;
}

export interface OrchestratorOptions {
  runtime: AgentRuntime;
  emit: EmitFn;
  maxRounds?: number;
  maxSpeakersPerRound?: number;
  maxMessagesPerTurn?: number;
  maxMessagesPerAgent?: number;
  attentionConcurrency?: number;
}

function messageTypeFor(actions: ValidatedAgentAction[]): MessageType {
  if (actions.some((a) => a.type === "create_artifact")) return "artifact";
  if (actions.some((a) => a.type === "create_task")) return "task_handoff";
  if (actions.some((a) => a.type === "propose_decision")) return "decision";
  if (actions.some((a) => a.type === "request_phase" || a.type === "set_phase")) return "decision";
  if (actions.some((a) => a.type === "block")) return "blocker";
  if (actions.some((a) => a.type === "ask_user")) return "question";
  return "discussion";
}

function actionChips(actions: ValidatedAgentAction[]): Array<{ kind: string; label: string }> {
  const chips: Array<{ kind: string; label: string }> = [];
  for (const action of actions) {
    const a = action as unknown as Record<string, unknown>;
    switch (action.type) {
      case "create_task":
        chips.push({ kind: "task", label: `任务：${String(a.title ?? "")}` });
        break;
      case "create_artifact":
        chips.push({ kind: "artifact", label: `产物：${String(a.title ?? "")}` });
        break;
      case "propose_decision":
        chips.push({
          kind: "decision",
          label: `${isEngineeringTopic(`${String(a.title ?? "")} ${String(a.rationale ?? "")}`) ? "内部决策" : "产品决策"}：${String(a.title ?? "")}`,
        });
        break;
      case "request_approval":
        chips.push({
          kind: "approval",
          label: `${/^product/i.test(String(a.targetType ?? "")) ? "待产品审批" : "内部审批"}：${String(a.title ?? "")}`,
        });
        break;
      case "remember":
        chips.push({ kind: "memory", label: `记忆候选：${String(a.title ?? "")}` });
        break;
      case "request_phase":
      case "set_phase":
        chips.push({ kind: "phase", label: `阶段推进：${String(a.phase ?? "")}（内部）` });
        break;
      case "handoff":
        chips.push({ kind: "handoff", label: `交给 @${String(a.to ?? "")}` });
        break;
      case "block":
        chips.push({ kind: "blocker", label: "标记阻塞" });
        break;
      default:
        break;
    }
  }
  return chips;
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

interface AttentionOutcome {
  role: RoleRow;
  speak: boolean;
  reason: string;
  forced: boolean;
  latencyMs: number;
}

export class Orchestrator {
  private runtime: AgentRuntime;
  private emit: EmitFn;
  private maxRounds: number;
  private maxSpeakersPerRound: number;
  private maxMessagesPerTurn: number;
  private maxMessagesPerAgent: number;
  private attentionConcurrency: number;

  constructor(options: OrchestratorOptions) {
    this.runtime = options.runtime;
    this.emit = options.emit;
    const positiveLimit = (value: number | undefined, fallback: number): number => {
      const parsed = Number(value ?? fallback);
      // 0 means "no fixed limit": the room stops when nobody wants to speak,
      // when a round repeats itself, or when the client presses Stop.
      return Number.isFinite(parsed) && parsed > 0 ? parsed : Infinity;
    };
    this.maxRounds = positiveLimit(options.maxRounds, Number(process.env.MAX_ROUNDS ?? 0));
    // One reply at a time. Other willing speakers are queued for later rounds,
    // so the room reads like a conversation instead of a panel broadcast.
    this.maxSpeakersPerRound = Math.min(
      1,
      options.maxSpeakersPerRound ?? Number(process.env.MAX_SPEAKERS_PER_ROUND ?? 1),
    );
    this.maxMessagesPerTurn = positiveLimit(
      options.maxMessagesPerTurn,
      Number(process.env.MAX_MESSAGES_PER_TURN ?? 0),
    );
    this.maxMessagesPerAgent = positiveLimit(
      options.maxMessagesPerAgent,
      Number(process.env.MAX_MESSAGES_PER_AGENT ?? 0),
    );
    this.attentionConcurrency =
      options.attentionConcurrency ?? Number(process.env.ATTENTION_CONCURRENCY ?? 4);
  }

  private async extractPlanTasks(
    bundle: RoomBundle,
    params: OrchestratorParams,
    turnId: string,
  ): Promise<{ messageId: string; taskCount: number } | null> {
    const db = getDb();
    const lead = bundle.roles.find((role) => role.key === "lead" && role.enabled);
    if (!lead) return null;

    const spec = await captureAcceptedSpec(bundle.project.id);
    if (!spec) {
      const messageId = uuidv7();
      await insertMessage({
        id: messageId,
        tenantId: bundle.project.tenantId,
        projectId: params.projectId,
        roomId: params.roomId,
        senderType: "system",
        senderName: "系统",
        type: "system_event",
        content: "当前 PRD / 验收标准还不是已接受状态，先把最新版本确认后再拆任务。",
        metadata: { turnId, kind: "plan_extract" },
      });
      await this.emit(EVENT_TYPES.messageCreated, {
        messageId,
        roomId: params.roomId,
        senderType: "system",
        senderName: "系统",
        type: "system_event",
      });
      return null;
    }

    const plan = bundle.artifacts.find((artifact) => artifact.kind === "plan");
    const planVersion = plan ? await latestArtifactContent(plan.id) : null;
    const lastLead = [...bundle.messages]
      .reverse()
      .find((message) => message.senderId === lead.id || message.metadata?.roleKey === "lead");
    const planText = (planVersion?.content || lastLead?.content || "").trim();
    if (!planText) return null;

    const runId = uuidv7();
    await db.insert(agentRuns).values({
      id: runId,
      projectId: params.projectId,
      roomId: params.roomId,
      roleId: lead.id,
      triggerMessageId: params.userMessageId,
      status: "running",
      startedAt: new Date(),
      metadata: { turnId, kind: "plan_extract", roleKey: "lead", runtime: this.runtime.name },
    });
    await this.emit(EVENT_TYPES.runStatusChanged, {
      runId,
      roleKey: "lead",
      roleName: lead.displayName,
      status: "running",
      kind: "plan_extract",
    });

    try {
      const result = await this.runtime.generate({
        roleKey: "lead",
        roleName: lead.displayName,
        system: `${buildSystemPrompt(bundle, "lead")}\n\n你现在只做任务提取，不参与讨论，不要创建产物。`,
        prompt: [
          "下面是从群里已经确认的实施计划。把计划拆成 3-6 个可执行任务。",
          "只输出一个 devteam 代码块，包含 create_task 动作；不要输出其他文字；不要创建产物。",
          "每个任务必须有 title、description、role、priority、acceptance（数组）。",
          "role 只能是 lead/pm/architect/frontend/backend/qa/security。",
          "只创建实现/测试类任务；不要创建 PRD、验收标准、契约修订、复核、收口、流程管理等 meta 任务。",
          "最多 4 个任务；不要重复已有任务。",
          "## 已有任务",
          bundle.tasks.map((task) => `- ${task.title}`).join("\n") || "（无）",
          "## 计划",
          planText.slice(0, 12_000),
        ].join("\n"),
        userMessage: "把计划落成结构化任务",
        phase: bundle.project.phase,
        signal: params.signal,
        model:
          lead.modelProvider && lead.modelId
            ? { providerID: lead.modelProvider, id: lead.modelId }
            : null,
      });

      const actions = result.actions.filter(
        (action) => action.type === "create_task",
      ) as ValidatedAgentAction[];

      if (!actions.length) {
        await db
          .update(agentRuns)
          .set({
            status: "succeeded",
            endedAt: new Date(),
            metadata: { turnId, kind: "plan_extract", roleKey: "lead", taskCount: 0 },
          })
          .where(eq(agentRuns.id, runId));
        await this.emit(EVENT_TYPES.runStatusChanged, {
          runId,
          roleKey: "lead",
          roleName: lead.displayName,
          status: "succeeded",
          kind: "plan_extract",
        });
        return null;
      }

      const messageId = uuidv7();
      await insertMessage({
        id: messageId,
        tenantId: bundle.project.tenantId,
        projectId: params.projectId,
        roomId: params.roomId,
        senderType: "agent",
        senderId: lead.id,
        senderName: lead.displayName,
        type: "task_handoff",
        content: `计划已落成 ${actions.length} 个结构化任务。`,
        metadata: {
          roleKey: "lead",
          turnId,
          kind: "plan_extract",
          chips: actionChips(actions),
          actionTypes: actions.map((action) => action.type),
        },
        runId,
        replyToId: params.userMessageId,
      });
      await this.emit(EVENT_TYPES.messageCreated, {
        messageId,
        roomId: params.roomId,
        roleKey: "lead",
        senderName: lead.displayName,
        type: "task_handoff",
      });

      const applied = await applyActions(actions, {
        bundle,
        actorRole: lead,
        messageId,
        emit: this.emit,
      });

      await db
        .update(agentRuns)
        .set({
          status: "succeeded",
          endedAt: new Date(),
          costCents: result.costCents,
          modelProvider: result.modelProvider,
          modelId: result.modelId,
          metadata: {
            turnId,
            kind: "plan_extract",
            roleKey: "lead",
            taskCount: applied.taskIds.length,
          },
        })
        .where(eq(agentRuns.id, runId));
      await this.emit(EVENT_TYPES.runStatusChanged, {
        runId,
        roleKey: "lead",
        roleName: lead.displayName,
        status: "succeeded",
        kind: "plan_extract",
        tasks: applied.taskIds.length,
      });

      return { messageId, taskCount: applied.taskIds.length };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await db
        .update(agentRuns)
        .set({ status: "failed", endedAt: new Date(), error: message.slice(0, 2000) })
        .where(eq(agentRuns.id, runId));
      await this.emit(EVENT_TYPES.runStatusChanged, {
        runId,
        roleKey: "lead",
        roleName: lead.displayName,
        status: "failed",
        kind: "plan_extract",
        error: message.slice(0, 500),
      });
      await insertMessage({
        id: uuidv7(),
        tenantId: bundle.project.tenantId,
        projectId: params.projectId,
        roomId: params.roomId,
        senderType: "system",
        senderName: "系统",
        type: "system_event",
        content: `自动把计划落成任务时没有完成：${message.slice(0, 300)}`,
        metadata: { turnId, kind: "plan_extract" },
      });
      return null;
    }
  }

  async run(params: OrchestratorParams): Promise<void> {
    const db = getDb();
    const loaded = await loadRoomBundle(params.projectId, params.roomId, 40);
    if (!loaded) throw new Error("room bundle not found");
    let bundle: RoomBundle = loaded;


    const enabledRoles = bundle.roles
      .filter((r) => r.enabled)
      .sort((a, b) => a.sortOrder - b.sortOrder);
    const enabledKeys = new Set(enabledRoles.map((r) => r.key));
    const requestedKeys = (params.participantKeys ?? []).filter((key) => enabledKeys.has(key));
    const roomKeys = enabledRoles.filter((r) => r.inRoom).map((r) => r.key);
    const initialKeys = requestedKeys.length ? requestedKeys : roomKeys;
    const activeKeys = new Set(initialKeys);
    const tasksBefore = bundle.tasks.length;

    const mentioned = new Set(
      [...(params.mentions ?? []), ...extractMentions(params.content)]
        .map((m) => normalizeMention(m))
        .filter((m): m is string => m !== null && enabledKeys.has(m)),
    );

    const turnId = uuidv7();
    for (const key of mentioned) activeKeys.add(key);

    if (!activeKeys.size) {
      const messageId = uuidv7();
      await insertMessage({
        id: messageId,
        tenantId: bundle.project.tenantId,
        projectId: params.projectId,
        roomId: params.roomId,
        senderType: "system",
        senderName: "系统",
        type: "system_event",
        content: "当前房间没有 Agent。请先在右侧「团队」里把至少一个 Agent 加入房间。",
        metadata: { turnId },
      });
      await this.emit(EVENT_TYPES.messageCreated, {
        messageId,
        roomId: params.roomId,
        senderType: "system",
        senderName: "系统",
        type: "system_event",
      });
      return;
    }

    // A user @mention can pull an agent into this turn even if it was outside
    // the room. Explicitly announce that, so the transcript is truthful.
    const invitedByUser = [...mentioned].filter((key) => !initialKeys.includes(key));
    if (invitedByUser.length) {
      const names = invitedByUser
        .map((key) => enabledRoles.find((r) => r.key === key)?.displayName ?? key)
        .join("、");
      const messageId = uuidv7();
      await insertMessage({
        id: messageId,
        tenantId: bundle.project.tenantId,
        projectId: params.projectId,
        roomId: params.roomId,
        senderType: "system",
        senderName: "系统",
        type: "system_event",
        content: `${names} 被 @ 加入本次讨论。`,
        metadata: { turnId, invited: invitedByUser },
      });
      await this.emit(EVENT_TYPES.messageCreated, {
        messageId,
        roomId: params.roomId,
        senderType: "system",
        senderName: "系统",
        type: "system_event",
      });
    }
    const spoken = new Map<string, number>();
    const wantedSummary = new Map<string, { role: string; name: string; reason: string }>();
    const postedSummary = new Map<string, { role: string; name: string; reason: string }>();
    const passedSummary = new Map<string, { role: string; name: string; reason: string }>();
    const forcedNext = new Map<string, string>();
    let trigger: RoomTrigger = {
      senderName: params.triggerLabel ?? `甲方（${params.userName}）`,
      content: params.content,
    };
    let totalMessages = 0;
    let round = 0;
    let waitingForUser = false;
    const seenRoundSignatures = new Set<string>();

    await this.emit(EVENT_TYPES.orchestrationStarted, {
      turnId,
      mode: "group",
      participants: [...activeKeys],
      triggerMessageId: params.userMessageId,
      runtime: this.runtime.name,
    });

    try {
      while (
        round < this.maxRounds &&
        totalMessages < this.maxMessagesPerTurn &&
        !params.signal?.aborted
      ) {
        const forcedThisRound = new Map<string, string>(forcedNext);
        forcedNext.clear();
        if (round === 0) {
          for (const key of mentioned) forcedThisRound.set(key, "被点名");
        }

        const stagePolicy = STAGE_POLICIES[bundle.project.phase as WorkflowPhase];
        const stageAllowed = new Set([
          stagePolicy.owner,
          ...stagePolicy.participants,
          ...stagePolicy.consult,
        ]);
        const participants = enabledRoles.filter(
          (role) =>
            activeKeys.has(role.key) &&
            (stageAllowed.has(role.key) || forcedThisRound.has(role.key)) &&
            (spoken.get(role.key) ?? 0) < this.maxMessagesPerAgent,
        );
        if (!participants.length) break;

        // 1) Everyone reads the room and independently decides whether to speak.
        const decisions = await mapLimit(
          participants,
          this.attentionConcurrency,
          async (role): Promise<AttentionOutcome> => {
            const forcedReason = forcedThisRound.get(role.key);
            if (forcedReason) {
              return {
                role,
                speak: true,
                reason: forcedReason,
                forced: true,
                latencyMs: 0,
              };
            }
            try {
              const result = await this.runtime.decide({
                roleKey: role.key,
                roleName: role.displayName,
                prompt: buildAttentionPrompt(
                  bundle,
                  role.key,
                  trigger,
                  spoken.get(role.key) ?? 0,
                  activeKeys,
                  params.repoContext,
                ),
                content: trigger.content,
                phase: bundle.project.phase,
                spokenCount: spoken.get(role.key) ?? 0,
                signal: params.signal,
                model:
                  role.modelProvider && role.modelId
                    ? { providerID: role.modelProvider, id: role.modelId }
                    : null,
              });
              return {
                role,
                speak: result.speak,
                reason: result.reason,
                forced: false,
                latencyMs: result.latencyMs,
              };
            } catch (error) {
              if (params.signal?.aborted) {
                return { role, speak: false, reason: "已停止", forced: false, latencyMs: 0 };
              }
              const fallback = heuristicAttention(
                role.key,
                trigger.content,
                role.displayName,
                bundle.project.phase as WorkflowPhase,
                spoken.get(role.key) ?? 0,
              );
              return {
                role,
                speak: fallback.speak,
                reason: `注意力模型不可用，按规则判断：${fallback.reason}`,
                forced: false,
                latencyMs: 0,
              };
            }
          },
        );

        for (const decision of decisions) {
          const entry = {
            role: decision.role.key,
            name: decision.role.displayName,
            reason: decision.reason,
          };
          if (decision.speak) wantedSummary.set(decision.role.key, entry);
          else passedSummary.set(decision.role.key, entry);
          await this.emit(EVENT_TYPES.agentAttention, {
            turnId,
            round,
            roleKey: decision.role.key,
            roleName: decision.role.displayName,
            speak: decision.speak,
            reason: decision.reason,
            latencyMs: decision.latencyMs,
          });
        }

        const remainingMessages = Math.max(0, this.maxMessagesPerTurn - totalMessages);
        const phaseOwner =
          ({
            requirements: "pm",
            design: "architect",
            coding: "lead",
            testing: "qa",
            deployment: "devops",
            operations: "devops",
          } as Record<string, string>)[bundle.project.phase] ?? "lead";
        const speakers = decisions
          .filter((d) => d.speak)
          .sort((a, b) => {
            if (a.forced !== b.forced) return Number(b.forced) - Number(a.forced);
            const aOwner = a.role.key === phaseOwner;
            const bOwner = b.role.key === phaseOwner;
            if (aOwner !== bOwner) return aOwner ? -1 : 1;
            const sa = spoken.get(a.role.key) ?? 0;
            const sb = spoken.get(b.role.key) ?? 0;
            if (sa !== sb) return sa - sb;
            return a.role.sortOrder - b.role.sortOrder;
          })
          .slice(0, Math.min(this.maxSpeakersPerRound, remainingMessages));

        // Agents that wanted to speak but did not fit this round get priority
        // next round instead of being silently dropped.
        for (const decision of decisions) {
          if (
            decision.speak &&
            !speakers.includes(decision) &&
            (spoken.get(decision.role.key) ?? 0) < this.maxMessagesPerAgent
          ) {
            forcedNext.set(decision.role.key, "上一轮排队，轮到你了");
          }
        }

        // Nobody has anything to add: the room goes quiet.
        if (!speakers.length) break;

        // 2) Speakers generate in parallel, then their messages are posted in
        //    a deterministic role order so the room has a stable transcript.
        const replies = await mapLimit(speakers, Math.min(3, speakers.length), async (decision) => {
          const role = decision.role;
          const runId = uuidv7();
          await db.insert(agentRuns).values({
            id: runId,
            projectId: params.projectId,
            roomId: params.roomId,
            roleId: role.id,
            triggerMessageId: params.userMessageId,
            status: "running",
            startedAt: new Date(),
            metadata: {
              turnId,
              round,
              kind: "reply",
              decision: "speak",
              reason: decision.reason,
              roleKey: role.key,
              runtime: this.runtime.name,
            },
          });
          await this.emit(EVENT_TYPES.runStatusChanged, {
            runId,
            roleKey: role.key,
            roleName: role.displayName,
            status: "running",
            kind: "reply",
            round,
          });

          try {
            const result = await this.runtime.generate({
              roleKey: role.key,
              roleName: role.displayName,
              system: buildSystemPrompt(bundle, role.key),
              prompt: buildPrompt(
                bundle,
                role.key,
                trigger,
                params.userName,
                round,
                activeKeys,
                params.repoContext,
              ),
              userMessage: trigger.content,
              phase: bundle.project.phase,
              signal: params.signal,
              model:
                role.modelProvider && role.modelId
                  ? { providerID: role.modelProvider, id: role.modelId }
                  : null,
            });
            return { role, decision, runId, result, error: null };
          } catch (error) {
            return { role, decision, runId, result: null, error };
          }
        });

        const posted: Array<{ senderName: string; text: string }> = [];

        for (const item of replies.sort((a, b) => a.role.sortOrder - b.role.sortOrder)) {
          if (item.error || !item.result) {
            const aborted = params.signal?.aborted === true;
            const message = item.error instanceof Error ? item.error.message : String(item.error);
            await db
              .update(agentRuns)
              .set({
                status: aborted ? "cancelled" : "failed",
                endedAt: new Date(),
                error: message.slice(0, 2000),
              })
              .where(eq(agentRuns.id, item.runId));
            await this.emit(EVENT_TYPES.runStatusChanged, {
              runId: item.runId,
              roleKey: item.role.key,
              roleName: item.role.displayName,
              status: aborted ? "cancelled" : "failed",
              kind: "reply",
              round,
              error: message.slice(0, 500),
            });
            if (!aborted) {
              await insertMessage({
                id: uuidv7(),
                tenantId: bundle.project.tenantId,
                projectId: params.projectId,
                roomId: params.roomId,
                senderType: "system",
                senderName: "系统",
                type: "system_event",
                content: `${item.role.displayName} 这次没有跑完：${message.slice(0, 300)}`,
                metadata: { turnId, round, roleKey: item.role.key },
              });
            }
            continue;
          }

          const result = item.result;
          let actions = params.readOnly ? [] : (result.actions as ValidatedAgentAction[]);
          if (params.phaseOnly) {
            actions = actions.filter(
              (action) => action.type === "request_phase" || action.type === "set_phase",
            );
          }
          const parseErrors = (result.metadata.parseErrors as string[] | undefined) ?? [];
          if (parseErrors.length) {
            const raw = (result.metadata.rawBlocks as string[] | undefined) ?? [];
            console.warn(
              `[agent] ${item.role.key} produced unparsed actions: ${parseErrors.join("; ")}`,
              raw.map((block) => block.slice(0, 600)),
            );
          }

          const askAction = actions.find((action) => action.type === "ask_user") as
            | { question?: string }
            | undefined;
          const engineeringAsk = Boolean(
            askAction?.question && isEngineeringTopic(askAction.question),
          );
          const decisionAction = actions.find((action) => action.type === "propose_decision") as
            | { title?: string; rationale?: string }
            | undefined;
          const approvalAction = actions.find((action) => action.type === "request_approval") as
            | { targetType?: string; title?: string; reason?: string }
            | undefined;
          const clientQuestion = Boolean(askAction?.question && !engineeringAsk);
          const clientDecision = Boolean(
            decisionAction?.title &&
              !isEngineeringTopic(`${decisionAction.title} ${decisionAction.rationale ?? ""}`),
          );
          const clientApproval = Boolean(
            approvalAction?.title && /^product/i.test(approvalAction.targetType ?? ""),
          );
          const clientFacing = clientQuestion || clientDecision || clientApproval;
          const content = engineeringAsk
            ? `${result.text.replace(askAction!.question!, "").trim()}\n\n（工程执行细节由团队内部决定，不需要甲方确认。）`.trim()
            : askAction?.question &&
                !result.text.includes(askAction.question) &&
                !/[?？]/.test(result.text)
              ? `${result.text}\n\n${askAction.question}`
              : result.text;
          const clientPrompt = clientDecision
            ? `产品决策待确认：${decisionAction!.title}\n${decisionAction!.rationale ?? ""}\n请回复「接受」或「不接受」，或在右侧产品决策中处理。`
            : clientApproval
              ? `产品审批待确认：${approvalAction!.title}\n${approvalAction!.reason ?? ""}\n请回复「批准」或「拒绝」，或在右侧产品审批中处理。`
              : "";
          const withPrompt =
            clientFacing &&
            clientPrompt &&
            !(decisionAction?.title && content.includes(decisionAction.title)) &&
            !(approvalAction?.title && content.includes(approvalAction.title))
              ? `${content}\n\n${clientPrompt}`
              : content;
          const finalContent =
            clientFacing && !withPrompt.includes("@甲方") ? `@甲方 ${withPrompt}` : withPrompt;
          const messageId = uuidv7();
          await insertMessage({
            id: messageId,
            tenantId: bundle.project.tenantId,
            projectId: params.projectId,
            roomId: params.roomId,
            senderType: "agent",
            senderId: item.role.id,
            senderName: item.role.displayName,
            type: messageTypeFor(actions),
            content: finalContent,
            metadata: {
              roleKey: item.role.key,
              turnId,
              round,
              decision: "speak",
              modelProvider: result.modelProvider,
              modelId: result.modelId,
              latencyMs: result.metadata.latencyMs ?? null,
              parseErrors: result.metadata.parseErrors ?? [],
              actionTypes: actions.map((a) => a.type),
              chips: actionChips(actions),
              clientQuestion: clientFacing,
            },
            runId: item.runId,
            replyToId: params.userMessageId,
          });
          await this.emit(EVENT_TYPES.messageCreated, {
            messageId,
            roomId: params.roomId,
            roleKey: item.role.key,
            senderName: item.role.displayName,
            type: messageTypeFor(actions),
            round,
          });

          const applied = await applyActions(actions, {
            bundle,
            actorRole: item.role,
            messageId,
            emit: this.emit,
          });

          await db
            .update(agentRuns)
            .set({
              status: "succeeded",
              endedAt: new Date(),
              costCents: result.costCents,
              modelProvider: result.modelProvider,
              modelId: result.modelId,
              metadata: {
                turnId,
                round,
                kind: "reply",
                decision: "speak",
                reason: item.decision.reason,
                roleKey: item.role.key,
                runtime: this.runtime.name,
                actions: applied.notes,
                createdTasks: applied.taskIds.length,
                createdArtifacts: applied.artifactIds.length,
              },
            })
            .where(eq(agentRuns.id, item.runId));
          await this.emit(EVENT_TYPES.runStatusChanged, {
            runId: item.runId,
            roleKey: item.role.key,
            roleName: item.role.displayName,
            status: "succeeded",
            kind: "reply",
            round,
            tasks: applied.taskIds.length,
            artifacts: applied.artifactIds.length,
          });

          spoken.set(item.role.key, (spoken.get(item.role.key) ?? 0) + 1);
          totalMessages += 1;
          posted.push({ senderName: item.role.displayName, text: result.text });
          if (!postedSummary.has(item.role.key)) {
            postedSummary.set(item.role.key, {
              role: item.role.key,
              name: item.role.displayName,
              reason: item.decision.reason,
            });
          }
          for (const mention of extractMentions(result.text)) {
            if (enabledKeys.has(mention)) {
              activeKeys.add(mention);
              forcedNext.set(mention, "同事在消息里点了你");
            }
          }
          if (applied.handoffTo && enabledKeys.has(applied.handoffTo)) {
            activeKeys.add(applied.handoffTo);
            forcedNext.set(applied.handoffTo, "收到同事的交接");
          }
          if (applied.askedUser || clientFacing) waitingForUser = true;
        }

        if (!posted.length) break;

        // There is no fixed round/message cap for ordinary conversation. Stop
        // a pathological A→B→A repetition instead of cutting a real exchange
        // off at an arbitrary number.
        const roundSignature = posted
          .map((p) => `${p.senderName}:${p.text.replace(/\s+/g, " ").trim()}`)
          .join("|");
        if (seenRoundSignatures.has(roundSignature)) {
          round += 1;
          break;
        }
        seenRoundSignatures.add(roundSignature);

        // A question to the client pauses the team. The next turn starts when
        // the client answers, instead of the agents talking over each other.
        if (waitingForUser) {
          round += 1;
          break;
        }

        // 3) The next round reads what was just said, then decides again.
        trigger = {
          senderName: "团队",
          content: posted.map((p) => `[${p.senderName}] ${p.text}`).join("\n\n"),
        };
        round += 1;
        const nextBundle = await loadRoomBundle(params.projectId, params.roomId, 40);
        if (!nextBundle) break;
        bundle = nextBundle;
      }

      // The plan is only useful if it becomes executable work. If planning
      // produced a plan artifact but no structured tasks, give the Lead one
      // focused extraction turn instead of asking the human to create tasks.
      if (
        !params.signal?.aborted &&
        bundle.project.phase === "design" &&
        bundle.artifacts.some((artifact) => artifact.kind === "plan") &&
        bundle.tasks.length <= tasksBefore
      ) {
        const extracted = await this.extractPlanTasks(bundle, params, turnId);
        if (extracted) {
          totalMessages += 1;
          if (!postedSummary.has("lead")) {
            const lead = bundle.roles.find((role) => role.key === "lead");
            if (lead) {
              postedSummary.set("lead", {
                role: "lead",
                name: lead.displayName,
                reason: "把计划落成结构化任务",
              });
            }
          }
          bundle = (await loadRoomBundle(params.projectId, params.roomId, 40)) ?? bundle;
        }
      }
    } finally {
      const postedKeys = new Set(postedSummary.keys());
      const passed = [...passedSummary.entries()]
        .filter(([key]) => !postedKeys.has(key))
        .map(([, value]) => value);
      for (const [key, value] of wantedSummary) {
        if (!postedKeys.has(key) && !passedSummary.has(key)) {
          passed.push({
            ...value,
            reason: "轮次/消息预算用尽，本轮未轮到发言",
          });
        }
      }

      const summary: TurnSummary = {
        turnId,
        rounds: round,
        received: activeKeys.size,
        messages: totalMessages,
        waitingForUser,
        spoke: [...postedSummary.values()],
        passed,
      };

      const [userMessage] = await db
        .select()
        .from(messages)
        .where(eq(messages.id, params.userMessageId))
        .limit(1);
      if (userMessage) {
        await db
          .update(messages)
          .set({ metadata: { ...userMessage.metadata, turn: summary } })
          .where(eq(messages.id, params.userMessageId));
        await this.emit(EVENT_TYPES.messageUpdated, { messageId: params.userMessageId });
      }

      await this.emit(EVENT_TYPES.orchestrationFinished, {
        turnId,
        rounds: round,
        messages: totalMessages,
        participants: [...activeKeys],
        summary,
      });
    }
  }
}
