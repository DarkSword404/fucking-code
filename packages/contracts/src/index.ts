/**
 * Shared contracts between the API, the web client and the agent layer.
 * These are deliberately dependency-free: they describe the wire format only.
 */

export const WORKFLOW_PHASES = [
  "requirements",
  "design",
  "coding",
  "testing",
  "deployment",
  "operations",
] as const;
export type WorkflowPhase = (typeof WORKFLOW_PHASES)[number];

export const PHASE_LABELS: Record<WorkflowPhase, string> = {
  requirements: "需求分析",
  design: "设计方案",
  coding: "编码",
  testing: "测试",
  deployment: "部署",
  operations: "运维中",
};

export const TASK_MODES = ["code", "workbench"] as const;
export type TaskMode = (typeof TASK_MODES)[number];

export const TASK_STATUSES = [
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
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const MESSAGE_TYPES = [
  "discussion",
  "question",
  "proposal",
  "review_request",
  "decision",
  "task_handoff",
  "artifact",
  "blocker",
  "system_event",
] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export const SENDER_TYPES = ["user", "agent", "system"] as const;
export type SenderType = (typeof SENDER_TYPES)[number];

export const RUN_STATUSES = [
  "queued",
  "starting",
  "running",
  "waiting_input",
  "waiting_approval",
  "succeeded",
  "failed",
  "cancel_requested",
  "cancelled",
  "timed_out",
  "orphaned",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const ARTIFACT_KINDS = [
  "prd",
  "acceptance_criteria",
  "design",
  "api_contract",
  "plan",
  "test_report",
  "spec_review",
  "security_requirements",
  "security_design",
  "sca_report",
  "sast_report",
  "code_audit",
  "security_test",
  "release_security",
  "diff",
  "repo_analysis",
  "note",
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const ARTIFACT_LABELS: Record<ArtifactKind, string> = {
  prd: "PRD",
  acceptance_criteria: "验收标准",
  design: "技术方案",
  api_contract: "接口契约",
  plan: "实施计划",
  test_report: "测试报告",
  spec_review: "规格核对",
  security_requirements: "安全需求",
  security_design: "安全设计 / 威胁模型",
  sca_report: "SCA 依赖扫描",
  sast_report: "SAST 静态扫描",
  code_audit: "代码安全审计",
  security_test: "安全测试 / 渗透",
  release_security: "发布安全检查",
  diff: "代码变更",
  repo_analysis: "仓库理解",
  note: "备注",
};

export const ARTIFACT_STATUSES = ["draft", "in_review", "accepted", "rejected", "superseded"] as const;
export type ArtifactStatus = (typeof ARTIFACT_STATUSES)[number];

export const DECISION_STATUSES = ["proposed", "accepted", "rejected", "superseded"] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

export const APPROVAL_STATUSES = ["pending", "approved", "rejected", "expired"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const MEMORY_STATUSES = ["proposed", "accepted", "rejected", "superseded"] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export const PRIORITIES = ["low", "medium", "high", "critical"] as const;
export type Priority = (typeof PRIORITIES)[number];

/** The action vocabulary agents may emit. This is the bridge from chat to structured state. */
export const AGENT_ACTIONS = [
  "create_task",
  "update_task",
  "create_artifact",
  "propose_decision",
  "request_approval",
  "remember",
  "request_phase",
  "set_phase",
  "handoff",
  "ask_user",
  "block",
] as const;
export type AgentActionType = (typeof AGENT_ACTIONS)[number];

export interface AgentAction {
  type: AgentActionType;
  [key: string]: unknown;
}

export interface Tenant {
  id: string;
  name: string;
  createdAt: string;
}

export interface User {
  id: string;
  tenantId: string;
  email: string;
  displayName: string;
  createdAt: string;
}

export interface Project {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  description: string;
  phase: WorkflowPhase;
  status: string;
  repoUrl: string | null;
  repoPath: string | null;
  repoSyncStatus?: string;
  repoSyncError?: string | null;
  repoSyncedAt?: string | null;
  repoSyncedCommit?: string | null;
  defaultBranch: string;
  baseCommit: string | null;
  budgetCents: number;
  spentCents: number;
  autoStartTasks: boolean;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface ProjectMember {
  projectId: string;
  userId: string;
  role: "owner" | "member" | "viewer";
  displayName?: string;
  email?: string;
}

export interface Room {
  id: string;
  projectId: string;
  name: string;
  kind: string;
  createdAt: string;
}

export interface MessageAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  url: string;
  archive?: boolean;
  entries?: number;
}

export interface Message {
  id: string;
  tenantId: string;
  projectId: string;
  roomId: string;
  seq: number;
  senderType: SenderType;
  senderId: string | null;
  senderName: string;
  type: MessageType;
  content: string;
  metadata: Record<string, unknown>;
  replyToId: string | null;
  taskId: string | null;
  artifactId: string | null;
  decisionId: string | null;
  runId: string | null;
  createdAt: string;
}

export interface AgentRole {
  id: string;
  projectId: string;
  key: string;
  displayName: string;
  description: string;
  systemPrompt: string;
  modelProvider: string | null;
  modelId: string | null;
  color: string;
  capabilities: string[];
  enabled: boolean;
  inRoom: boolean;
  sortOrder: number;
}

export interface AgentRun {
  id: string;
  projectId: string;
  roomId: string;
  roleId: string;
  roleKey?: string;
  roleName?: string;
  triggerMessageId: string | null;
  status: RunStatus;
  modelProvider: string | null;
  modelId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  error: string | null;
  costCents: number;
  metadata: Record<string, unknown>;
}

export interface SpecRef {
  id: string;
  version: number;
  title: string;
}

export interface TaskSpec {
  prd: SpecRef;
  acceptance: SpecRef;
  contracts: SpecRef[];
  capturedAt: string;
}

export interface Task {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: TaskStatus;
  mode?: TaskMode;
  priority: Priority;
  roleKey: string | null;
  createdFromMessageId: string | null;
  requirementVersion: number;
  spec: TaskSpec | Record<string, never>;
  acceptance: string[];
  evidence: Record<string, unknown>;
  blockedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskDependency {
  taskId: string;
  dependsOnTaskId: string;
}

export interface Artifact {
  id: string;
  projectId: string;
  kind: ArtifactKind;
  artifactKey: string;
  title: string;
  status: ArtifactStatus;
  currentVersion: number;
  createdByType: SenderType;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactVersion {
  id: string;
  artifactId: string;
  version: number;
  content: string;
  summary: string;
  sourceMessageId: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface ArtifactWithContent extends Artifact {
  content: string;
  summary: string;
  versions: ArtifactVersion[];
}

export interface Decision {
  id: string;
  projectId: string;
  title: string;
  status: DecisionStatus;
  rationale: string;
  alternatives: string[];
  proposedBy: string | null;
  decidedBy: string | null;
  sourceMessageId: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface Approval {
  id: string;
  projectId: string;
  targetType: string;
  targetId: string;
  targetVersion: number;
  title: string;
  status: ApprovalStatus;
  requestedBy: string | null;
  decidedBy: string | null;
  reason: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface Memory {
  id: string;
  projectId: string;
  type: string;
  title: string;
  content: string;
  status: MemoryStatus;
  version: number;
  sourceMessageIds: string[];
  confidence: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceEvent {
  seq: number;
  tenantId: string;
  projectId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ProjectSnapshot {
  project: Project;
  room: Room;
  roles: AgentRole[];
  tasks: Task[];
  artifacts: Artifact[];
  decisions: Decision[];
  approvals: Approval[];
  runs: AgentRun[];
  phaseRequirements: PhaseRequirement[];
  nextPhase: WorkflowPhase | null;
  canAdvance: boolean;
  /** Latest persisted event seq. SSE resumes from here. */
  eventCursor: number;
}

export interface PhaseRequirement {
  label: string;
  met: boolean;
}

export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    requestId: string;
  };
}

export const EVENT_TYPES = {
  messageCreated: "message.created",
  runStatusChanged: "agent.run.status_changed",
  taskChanged: "task.changed",
  artifactChanged: "artifact.changed",
  decisionChanged: "decision.changed",
  approvalChanged: "approval.changed",
  projectChanged: "project.changed",
  phaseChanged: "project.phase_changed",
  orchestrationStarted: "orchestration.started",
  orchestrationFinished: "orchestration.finished",
  orchestrationFailed: "orchestration.failed",
  agentAttention: "agent.attention",
  messageUpdated: "message.updated",
} as const;

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

/** A round-based group-chat summary attached to the user message that started it. */
export interface TurnSummary {
  turnId: string;
  rounds: number;
  received: number;
  messages: number;
  waitingForUser?: boolean;
  spoke: Array<{ role: string; name: string; reason: string }>;
  passed: Array<{ role: string; name: string; reason: string }>;
}

/** A single agent turn as returned by the runtime, before persistence. */
export interface AgentTurnResult {
  text: string;
  actions: AgentAction[];
  modelProvider: string | null;
  modelId: string | null;
  costCents: number;
  metadata: Record<string, unknown>;
}

export interface ChatRequest {
  content: string;
  mentions?: string[];
  /** Optional per-turn roster override. Empty/undefined means the room roster. */
  participants?: string[];
}

export interface AdvancePhaseRequest {
  to?: WorkflowPhase;
  note?: string;
}

export interface CreateProjectRequest {
  name: string;
  description?: string;
  repoUrl?: string;
  repoPath?: string;
}
