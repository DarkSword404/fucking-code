import { z } from "zod";
import { jsonrepair } from "jsonrepair";
import {
  AGENT_ACTIONS,
  ARTIFACT_KINDS,
  PRIORITIES,
  WORKFLOW_PHASES,
  type AgentAction,
} from "@devteam/contracts";
import { ROLE_KEYS } from "./roles.js";

const roleKey = z.enum(ROLE_KEYS as [string, ...string[]]);
const phase = z.enum(WORKFLOW_PHASES as unknown as [string, ...string[]]);
const artifactKind = z.enum(ARTIFACT_KINDS as unknown as [string, ...string[]]);

const createTask = z.object({
  type: z.literal("create_task"),
  title: z.string().min(1).max(240),
  description: z.string().max(8000).default(""),
  role: roleKey.optional(),
  priority: z.enum(PRIORITIES as unknown as [string, ...string[]]).default("medium"),
  acceptance: z.array(z.string().max(500)).max(20).default([]),
});

const updateTask = z.object({
  type: z.literal("update_task"),
  taskId: z.string().optional(),
  taskTitle: z.string().optional(),
  status: z
    .enum([
      "proposed",
      "ready",
      "in_progress",
      "blocked",
      "review",
      "testing",
      "done",
      "failed",
      "cancelled",
      "stale",
      "needs_replan",
    ])
    .optional(),
  evidence: z.string().max(4000).optional(),
  blockedReason: z.string().max(2000).optional(),
});

const createArtifact = z.object({
  type: z.literal("create_artifact"),
  kind: artifactKind,
  title: z.string().min(1).max(240),
  summary: z.string().max(1000).default(""),
  content: z.string().min(1).max(200_000),
});

const proposeDecision = z.object({
  type: z.literal("propose_decision"),
  title: z.string().min(1).max(240),
  rationale: z.string().max(8000).default(""),
  alternatives: z.array(z.string().max(1000)).max(10).default([]),
});

const requestApproval = z.object({
  type: z.literal("request_approval"),
  targetType: z.string().min(1).max(64).default("phase_review"),
  targetId: z.string().optional(),
  title: z.string().min(1).max(240),
  reason: z.string().max(4000).default(""),
});

const remember = z.object({
  type: z.literal("remember"),
  kind: z.string().min(1).max(40).default("fact"),
  title: z.string().min(1).max(240),
  content: z.string().min(1).max(4000),
});

const requestPhase = z.object({
  type: z.literal("request_phase"),
  phase,
  reason: z.string().min(1).max(2000),
});

/** Legacy action kept parseable, but applyActions turns it into a client confirmation. */
const setPhase = z.object({
  type: z.literal("set_phase"),
  phase,
  reason: z.string().max(2000).optional(),
});

const handoff = z.object({
  type: z.literal("handoff"),
  to: roleKey,
  note: z.string().max(2000).default(""),
});

const askUser = z.object({
  type: z.literal("ask_user"),
  question: z.string().min(1).max(2000),
});

const block = z.object({
  type: z.literal("block"),
  reason: z.string().min(1).max(2000),
});

export const agentActionSchema = z.discriminatedUnion("type", [
  createTask,
  updateTask,
  createArtifact,
  proposeDecision,
  requestApproval,
  remember,
  requestPhase,
  setPhase,
  handoff,
  askUser,
  block,
]);

export const actionEnvelopeSchema = z.object({
  actions: z.array(z.unknown()).max(20),
});

export type CreateTaskAction = z.infer<typeof createTask>;
export type UpdateTaskAction = z.infer<typeof updateTask>;
export type CreateArtifactAction = z.infer<typeof createArtifact>;
export type ProposeDecisionAction = z.infer<typeof proposeDecision>;
export type RequestApprovalAction = z.infer<typeof requestApproval>;
export type RememberAction = z.infer<typeof remember>;
export type RequestPhaseAction = z.infer<typeof requestPhase>;
export type SetPhaseAction = z.infer<typeof setPhase>;
export type HandoffAction = z.infer<typeof handoff>;
export type AskUserAction = z.infer<typeof askUser>;
export type BlockAction = z.infer<typeof block>;
export type ValidatedAgentAction = z.infer<typeof agentActionSchema>;

const FENCE = /```devteam\s*([\s\S]*?)```/gi;

function repairJson(raw: string): string {
  return raw
    .replace(/^\uFEFF/, "")
    .replace(/,\s*([}\]])/g, "$1")
    .trim();
}

export interface ParsedAgentOutput {
  /** Text safe to show in the chat room (protocol blocks removed). */
  text: string;
  actions: AgentAction[];
  errors: string[];
  /** Raw blocks that failed validation, for observability (never shown to users). */
  rawBlocks: string[];
}

/**
 * Parse an agent reply into human-visible text plus validated actions.
 * Malformed blocks never throw: the chat message still lands, and the error
 * is recorded for observability instead of breaking the run.
 */
export function parseAgentOutput(raw: string): ParsedAgentOutput {
  const actions: AgentAction[] = [];
  const errors: string[] = [];
  const rawBlocks: string[] = [];
  let text = raw;

  const blocks = [...raw.matchAll(FENCE)];
  for (const match of blocks) {
    text = text.replace(match[0], "");
    const body = repairJson(match[1] ?? "");
    if (!body) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      // Real models routinely emit raw newlines / trailing commas inside
      // string values. jsonrepair is the tolerant layer; we still validate
      // the result with zod before touching project state.
      try {
        parsed = JSON.parse(jsonrepair(body));
      } catch {
        errors.push("agent action block is not valid JSON (repair failed)");
        rawBlocks.push(body.slice(0, 4000));
        continue;
      }
    }

    let candidates: unknown[] | null = null;
    const envelope = actionEnvelopeSchema.safeParse(parsed);
    if (envelope.success) {
      candidates = envelope.data.actions;
    } else if (Array.isArray(parsed)) {
      candidates = parsed;
    } else if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      if (Array.isArray(obj.actions)) candidates = obj.actions;
      else if (Array.isArray(obj.tasks)) {
        candidates = obj.tasks.map((task) =>
          task && typeof task === "object" ? { type: "create_task", ...task } : task,
        );
      } else if (Array.isArray(obj.artifacts)) {
        candidates = obj.artifacts.map((artifact) =>
          artifact && typeof artifact === "object" ? { type: "create_artifact", ...artifact } : artifact,
        );
      } else if (typeof obj.type === "string") {
        candidates = [obj];
      }
    }

    if (!candidates) {
      errors.push("agent action envelope has an invalid shape");
      rawBlocks.push(body.slice(0, 4000));
      continue;
    }

    for (const candidate of candidates) {
      const result = agentActionSchema.safeParse(candidate);
      if (result.success) {
        actions.push(result.data as AgentAction);
      } else {
        const type =
          typeof candidate === "object" && candidate && "type" in candidate
            ? String((candidate as { type: unknown }).type)
            : "unknown";
        errors.push(`invalid action "${type}": ${result.error.issues[0]?.message ?? "bad shape"}`);
        rawBlocks.push(JSON.stringify(candidate).slice(0, 1000));
      }
    }
  }

  text = text.replace(/\n{3,}/g, "\n\n").trim();
  if (!text && actions.length > 0) {
    text = "（已更新项目状态，详见右侧面板。）";
  }
  return { text, actions, errors, rawBlocks };
}

export function isKnownActionType(value: string): boolean {
  return (AGENT_ACTIONS as readonly string[]).includes(value);
}
