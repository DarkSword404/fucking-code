import type { AgentTurnResult, WorkflowPhase } from "@devteam/contracts";
import { parseAgentOutput } from "@devteam/domain";
import { createModelGateway, type ModelGateway, type ModelFile } from "./gateway.js";
import { heuristicAttention, parseAttentionDecision } from "./attention.js";

export interface GenerateRequest {
  roleKey: string;
  roleName: string;
  system: string;
  prompt: string;
  userMessage: string;
  phase: string;
  files?: ModelFile[];
  signal?: AbortSignal;
  model?: { providerID: string; id: string } | null;
}

export interface AttentionRequest {
  roleKey: string;
  roleName: string;
  prompt: string;
  content: string;
  phase: string;
  spokenCount?: number;
  signal?: AbortSignal;
  model?: { providerID: string; id: string } | null;
}

export interface AttentionResult {
  speak: boolean;
  reason: string;
  latencyMs: number;
  modelProvider: string;
  modelId: string;
}

export interface AgentRuntime {
  readonly name: string;
  generate(request: GenerateRequest): Promise<AgentTurnResult>;
  decide(request: AttentionRequest): Promise<AttentionResult>;
}

/**
 * Calls the local OpenCode server's one-shot generation endpoint.
 *
 * Why one-shot instead of a full coding session: discussion turns should be
 * cheap, fast and tool-free. Code work is a separate, explicit run that gets a
 * session bound to an isolated worktree (next milestone).
 */
export class OpenCodeRuntime implements AgentRuntime {
  readonly name = "opencode";
  private provider: string;
  private modelId: string;
  private gateway: ModelGateway;

  constructor(options?: { provider?: string; modelId?: string; gateway?: ModelGateway }) {
    this.provider = options?.provider ?? process.env.AGENT_MODEL_PROVIDER ?? "opencode-go";
    this.modelId = options?.modelId ?? process.env.AGENT_MODEL_ID ?? "deepseek-v4.1-flash";
    this.gateway = options?.gateway ?? createModelGateway();
  }

  async generate(request: GenerateRequest): Promise<AgentTurnResult> {
    const started = Date.now();
    const baseModel = request.model ?? { providerID: this.provider, id: this.modelId };
    const model = request.files?.length
      ? {
          providerID:
            process.env.MULTIMODAL_MODEL_PROVIDER ??
            (this.gateway.name === "opencode" ? "opencode-go" : baseModel.providerID),
          id:
            process.env.MULTIMODAL_MODEL_ID ??
            (this.gateway.name === "opencode" ? "gemini-4-argon" : baseModel.id),
        }
      : baseModel;
    const configuredTimeout = Number(process.env.AGENT_TURN_TIMEOUT_MS ?? 0);
    const baseTimeout = configuredTimeout > 0 ? configuredTimeout : 180_000;
    const timeoutMs =
      request.roleKey === "architect" ? Math.max(baseTimeout, 300_000) : baseTimeout;

    let text: string;
    try {
      text = await this.gateway.generateText({
        system: request.system,
        prompt: request.prompt,
        model,
        files: request.files,
        signal: request.signal,
        timeoutMs,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A timeout already used the whole per-turn budget; retrying it would
      // just double the room's silence. Only retry fast transport failures.
      const transient =
        !/timeout|timed out|aborted/i.test(message) &&
        /ECONNRESET|ECONNREFUSED|fetch failed|socket hang up|50[234]/i.test(message);
      if (request.signal?.aborted || !transient) throw error;
      // One retry keeps a single jittery gateway call from turning into a
      // failed task or a silent room.
      text = await this.gateway.generateText({
        system: request.system,
        prompt: request.prompt,
        model,
        files: request.files,
        signal: request.signal,
        timeoutMs,
      });
    }

    const parsed = parseAgentOutput(text);
    return {
      text: parsed.text,
      actions: parsed.actions,
      modelProvider: model.providerID,
      modelId: model.id,
      costCents: 0,
      metadata: {
        runtime: this.name,
        latencyMs: Date.now() - started,
        parseErrors: parsed.errors,
        rawBlocks: parsed.rawBlocks,
      },
    };
  }

  async decide(request: AttentionRequest): Promise<AttentionResult> {
    const started = Date.now();
    const provider = process.env.ATTENTION_MODEL_PROVIDER ?? this.provider;
    const id = process.env.ATTENTION_MODEL_ID ?? "mimo-v2.6-flash";
    const model = { providerID: provider, id };

    const text = await this.gateway.generateText({
      system: "You are the attention router. Reply with PASS or SPEAK: reason.",
      prompt: request.prompt,
      model,
      signal: request.signal,
      timeoutMs: 45_000,
    });
    const decision = parseAttentionDecision(text);
    return {
      speak: decision.speak,
      reason: decision.reason,
      latencyMs: Date.now() - started,
      modelProvider: model.providerID,
      modelId: model.id,
    };
  }
}

/**
 * Deterministic offline runtime. Used by tests, CI and `AGENT_RUNTIME=mock`.
 * It exercises the same action protocol as a real model so the whole pipeline
 * (chat -> tasks -> artifacts -> gates) stays testable without network calls.
 */
export class MockRuntime implements AgentRuntime {
  readonly name = "mock";

  async decide(request: AttentionRequest): Promise<AttentionResult> {
    await new Promise((r) => setTimeout(r, 30));
    const decision = heuristicAttention(
      request.roleKey,
      request.content,
      request.roleName,
      request.phase as WorkflowPhase,
      request.spokenCount ?? 0,
    );
    return {
      speak: decision.speak,
      reason: decision.reason,
      latencyMs: 30,
      modelProvider: "mock",
      modelId: "mock-attention",
    };
  }

  async generate(request: GenerateRequest): Promise<AgentTurnResult> {
    await new Promise((r) => setTimeout(r, 120));
    const text = mockReply(request);
    const parsed = parseAgentOutput(text);
    return {
      text: parsed.text,
      actions: parsed.actions,
      modelProvider: "mock",
      modelId: "mock-1",
      costCents: 0,
      metadata: { runtime: this.name, parseErrors: parsed.errors },
    };
  }
}

function mockReply(request: GenerateRequest): string {
  const msg = request.userMessage;
  const safe = msg.replace(/"/g, "'").slice(0, 200);
  switch (request.roleKey) {
    case "pm":
      return `收到。我先把这次的目标和边界写清楚，重点是「${msg.slice(0, 40)}」。

\`\`\`devteam
{"actions":[
 {"type":"create_artifact","kind":"prd","title":"PRD v1","summary":"目标、范围与验收标准","content":"# PRD\\n\\n## 背景\\n${safe}\\n\\n## 目标\\n- 交付一个可演示的最小版本\\n\\n## 非目标\\n- 暂不做多租户计费\\n\\n## 验收标准\\n- Given 用户打开项目 When 发送需求 Then 团队给出可执行计划"},
 {"type":"create_artifact","kind":"acceptance_criteria","title":"验收标准 v1","summary":"可验证的验收条件","content":"# 验收标准\\n\\n1. 需求可被拆成任务\\n2. 每个任务有明确负责人\\n3. 交付前有测试证据"}
]}
\`\`\``;
    case "architect":
      return `方案我建议先做模块化单体：API + Worker 同进程，按领域分包，等真实负载再拆。

\`\`\`devteam
{"actions":[
 {"type":"create_artifact","kind":"design","title":"技术方案 v1","summary":"模块边界与数据流","content":"# 技术方案\\n\\n## 模块\\n- web / api / agents / db\\n\\n## 数据流\\n消息 -> 编排器 -> 结构化动作 -> 任务/产物\\n\\n## 风险\\n- 多 Agent 成本与轮次失控"},
 {"type":"propose_decision","title":"首版采用模块化单体","rationale":"降低部署与事务复杂度，保留拆分边界","alternatives":["一开始就拆微服务"]}
]}
\`\`\``;
    case "lead":
      return `方案能落地。我拆成三个任务，前后端可以并行，QA 等接口稳定后介入。

\`\`\`devteam
{"actions":[
 {"type":"create_task","title":"实现笔记列表与编辑器","description":"列表、空态、编辑保存","role":"frontend","priority":"high","acceptance":["可创建笔记","刷新后仍在"]},
 {"type":"create_task","title":"实现笔记 API 与存储","description":"CRUD、校验、迁移","role":"backend","priority":"high","acceptance":["接口幂等","错误码稳定"]},
 {"type":"create_task","title":"补齐端到端测试","description":"覆盖创建、编辑、搜索失败路径","role":"qa","priority":"medium","acceptance":["失败路径有断言"]},
 {"type":"request_phase","phase":"coding","reason":"设计已收敛，建议进入编码阶段"}
]}
\`\`\``;
    case "qa":
      return `我先按风险排序：创建/保存/搜索是主路径，重复提交和空结果是高概率失败点。测试报告会在有真实执行证据后给结论。

\`\`\`devteam
{"actions":[
 {"type":"create_artifact","kind":"test_report","title":"测试报告 v1","summary":"策略与覆盖范围","content":"# 测试报告\\n\\n## 覆盖\\n- 创建、编辑、搜索\\n- 空结果、重复提交\\n\\n## 结论\\n- 待执行"}
]}
\`\`\``;
    default:
      return `收到，我这边先按任务推进。有接口或验收上的歧义我会直接在群里提出来，不自己猜。`;
  }
}

export function createRuntime(): AgentRuntime {
  const mode = process.env.AGENT_RUNTIME ?? "opencode";
  if (mode === "mock") return new MockRuntime();
  return new OpenCodeRuntime();
}
