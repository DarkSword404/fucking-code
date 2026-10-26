import { createSignal } from "solid-js";
import {
  EVENT_TYPES,
  type AgentRun,
  type ArtifactWithContent,
  type Message,
  type PhaseRequirement,
  type ProjectSnapshot,
  type Task,
  type WorkspaceEvent,
} from "@devteam/contracts";
import { api, ApiError, type AdminInvite, type AdminProject, type AdminStats, type AdminUser, type AuthUser, type FileEntry, type ProjectListItem, type TestRunItem, type WorkspaceItem } from "./api";

export type ViewKey = "chat" | "tasks" | "code" | "artifacts" | "activity" | "admin";
export type RightTab = "team" | "gate" | "runs";

export const [projects, setProjects] = createSignal<ProjectListItem[]>([]);
export const [currentId, setCurrentId] = createSignal<string | null>(null);
export const [authUser, setAuthUser] = createSignal<AuthUser | null>(null);
export const [authChecked, setAuthChecked] = createSignal(false);
export const [demoMode, setDemoMode] = createSignal(false);
export const [adminStats, setAdminStats] = createSignal<AdminStats | null>(null);
export const [adminUsers, setAdminUsers] = createSignal<AdminUser[]>([]);
export const [adminProjects, setAdminProjects] = createSignal<AdminProject[]>([]);
export const [adminInvites, setAdminInvites] = createSignal<AdminInvite[]>([]);
export const [adminLoading, setAdminLoading] = createSignal(false);
export const [codeTab, setCodeTab] = createSignal<"files" | "diff" | "tests" | "terminal">("files");
export const [codeSource, setCodeSource] = createSignal<"repo" | "workspace">("repo");
export const [workspaces, setWorkspaces] = createSignal<WorkspaceItem[]>([]);
export const [activeWorkspaceId, setActiveWorkspaceId] = createSignal<string | null>(null);
export const [codeFiles, setCodeFiles] = createSignal<FileEntry[]>([]);
export const [selectedFilePath, setSelectedFilePath] = createSignal<string | null>(null);
export const [selectedFileContent, setSelectedFileContent] = createSignal<string | null>(null);
export const [codeDiff, setCodeDiff] = createSignal("");
export const [codeTestRuns, setCodeTestRuns] = createSignal<TestRunItem[]>([]);
export const [codeLoading, setCodeLoading] = createSignal(false);
export const [codeError, setCodeError] = createSignal("");
export const [snapshot, setSnapshot] = createSignal<ProjectSnapshot | null>(null);
export const [messages, setMessages] = createSignal<Message[]>([]);
export const [view, setView] = createSignal<ViewKey>("chat");
export const [rightTab, setRightTab] = createSignal<RightTab>("team");
export const [loading, setLoading] = createSignal(true);
export const [sending, setSending] = createSignal(false);
export const [thinking, setThinking] = createSignal<string[]>([]);
export const [roomReading, setRoomReading] = createSignal(false);
export const [connected, setConnected] = createSignal(false);
export const [error, setError] = createSignal<string | null>(null);
export const [leftCollapsed, setLeftCollapsed] = createSignal(false);
export const [rightOpen, setRightOpen] = createSignal(true);
export const [leftOpen, setLeftOpen] = createSignal(true);
export const [leftWidth, setLeftWidth] = createSignal(248);
export const [rightWidth, setRightWidth] = createSignal(340);
export const [selectedArtifact, setSelectedArtifact] = createSignal<ArtifactWithContent | null>(null);
export const [gateError, setGateError] = createSignal<PhaseRequirement[] | null>(null);
export const [runs, setRuns] = createSignal<AgentRun[]>([]);
export const [createOpen, setCreateOpen] = createSignal(false);
export const [settingsOpen, setSettingsOpen] = createSignal(false);
export const [decisionOpen, setDecisionOpen] = createSignal(false);
export const [autoStartError, setAutoStartError] = createSignal<string | null>(null);
export const [workingTaskId, setWorkingTaskId] = createSignal<string | null>(null);
export const [turnParticipants, setTurnParticipants] = createSignal<string[] | null>(null);
export interface PresenceUser {
  userId: string;
  displayName: string;
  lastSeen: number;
}
export const [presence, setPresence] = createSignal<PresenceUser[]>([]);

let lastEventSeq = 0;
let projectLoadToken = 0;
let codeLoadToken = 0;
let source: EventSource | null = null;
let snapshotTimer: number | undefined;
let messageTimer: number | undefined;
let errorTimer: number | undefined;
let codeTimer: number | undefined;
let lastPendingDecisionCount = 0;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function pendingDecisionCount(snap: ProjectSnapshot | null = snapshot()): number {
  if (!snap) return 0;
  return (
    snap.approvals.filter((item) => item.status === "pending").length +
    snap.artifacts.filter((item) => item.status === "in_review").length +
    snap.decisions.filter((item) => item.status === "proposed").length +
    snap.tasks.filter((item) => ["review", "testing"].includes(item.status)).length
  );
}

function applySnapshot(snap: ProjectSnapshot): void {
  setSnapshot(snap);
  const count = pendingDecisionCount(snap);
  if (count > 0 && lastPendingDecisionCount === 0) setDecisionOpen(true);
  lastPendingDecisionCount = count;
}

export function openDecisionInbox(): void {
  setAutoStartError(null);
  setDecisionOpen(true);
}

export function closeDecisionInbox(): void {
  setDecisionOpen(false);
  setAutoStartError(null);
}

export function toast(message: string): void {
  setError(message);
  window.clearTimeout(errorTimer);
  errorTimer = window.setTimeout(() => setError(null), 6500);
}

function mergeMessages(existing: Message[], incoming: Message[]): Message[] {
  const map = new Map(existing.map((m) => [m.id, m]));
  for (const message of incoming) map.set(message.id, message);
  return [...map.values()].sort((a, b) => a.seq - b.seq);
}

function closeStream(): void {
  source?.close();
  source = null;
  setConnected(false);
}

if (typeof window !== "undefined") {
  window.addEventListener("devteam:unauthorized", () => {
    setAuthUser(null);
    setDemoMode(false);
    closeStream();
    resetCodeState();
    setProjects([]);
    setSnapshot(null);
    setMessages([]);
    setCurrentId(null);
    setSelectedArtifact(null);
    setThinking([]);
    setRoomReading(false);
    setPresence([]);
  });
}

function connect(id: string): void {
  const es = new EventSource(`/api/v1/projects/${id}/events?cursor=${lastEventSeq}`);
  source = es;
  es.addEventListener("ready", () => setConnected(true));
  es.addEventListener("workspace", (event) => {
    let parsed: WorkspaceEvent;
    try {
      parsed = JSON.parse((event as MessageEvent).data) as WorkspaceEvent;
    } catch {
      return;
    }
    if (parsed.seq <= lastEventSeq) return;
    lastEventSeq = parsed.seq;
    handleEvent(parsed);
  });
  es.addEventListener("presence", (event) => {
    try {
      const data = JSON.parse((event as MessageEvent).data) as { users?: PresenceUser[] };
      setPresence(Array.isArray(data.users) ? data.users : []);
    } catch {
      // ignore malformed presence frames
    }
  });
  es.onerror = () => {
    setConnected(false);
    es.close();
    if (source === es) source = null;
    window.setTimeout(() => {
      if (currentId() === id) connect(id);
    }, 1500);
  };
}

function handleEvent(event: WorkspaceEvent): void {
  const payload = event.payload as Record<string, unknown>;
  if (event.type === EVENT_TYPES.messageCreated) scheduleMessages();
  if (event.type === EVENT_TYPES.messageUpdated) scheduleMessages();

  if (event.type === EVENT_TYPES.orchestrationStarted) {
    setRoomReading(true);
    setThinking([]);
  }

  if (event.type === EVENT_TYPES.runStatusChanged) {
    const kind = String(payload.kind ?? "");
    const name = String(payload.roleName ?? "");
    if (kind !== "attention" && name) {
      if (payload.status === "running") {
        setThinking((prev) => (prev.includes(name) ? prev : [...prev, name]));
      } else {
        setThinking((prev) => prev.filter((n) => n !== name));
      }
    }
  }

  if (event.type === EVENT_TYPES.orchestrationFinished) {
    setRoomReading(false);
    setThinking([]);
  }
  if (event.type === EVENT_TYPES.orchestrationFailed) {
    setRoomReading(false);
    setThinking([]);
    toast(String(payload.error ?? "Agent 运行失败"));
  }
  if (event.type === EVENT_TYPES.projectChanged) {
    const action = String(payload.action ?? "");
    if (action === "members_updated" || action === "updated" || action === "created") {
      void reloadProjects();
    }
  }

  scheduleSnapshot();
  if (view() === "code") scheduleCodeRefresh();
}

function scheduleSnapshot(): void {
  window.clearTimeout(snapshotTimer);
  snapshotTimer = window.setTimeout(() => {
    void refreshSnapshot();
  }, 260);
}

function scheduleMessages(): void {
  window.clearTimeout(messageTimer);
  messageTimer = window.setTimeout(() => {
    void refreshMessages();
  }, 180);
}

function scheduleCodeRefresh(): void {
  window.clearTimeout(codeTimer);
  codeTimer = window.setTimeout(() => {
    if (view() === "code") void loadCodeView();
  }, 500);
}

async function refreshSnapshot(): Promise<void> {
  const id = currentId();
  if (!id) return;
  try {
    const snap = await api.snapshot(id);
    if (currentId() === id) applySnapshot(snap);
  } catch {
    // background refresh: do not interrupt the conversation with a toast
  }
}

async function refreshMessages(): Promise<void> {
  const id = currentId();
  if (!id) return;
  try {
    const page = await api.messages(id);
    if (currentId() === id) setMessages((prev) => mergeMessages(prev, page.items));
  } catch {
    // ignore
  }
}

async function refreshRuns(): Promise<void> {
  const id = currentId();
  if (!id) return;
  try {
    const page = await api.runs(id);
    if (currentId() === id) setRuns(page.items);
  } catch {
    // ignore
  }
}

export async function bootstrap(): Promise<void> {
  try {
    const me = await api.me();
    setDemoMode(me.demoMode);
    await loadWorkspace();
    setAuthUser(me);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      setAuthUser(null);
    } else {
      toast(messageOf(err));
    }
  } finally {
    setAuthChecked(true);
    setLoading(false);
  }
}

async function loadWorkspace(): Promise<void> {
  const list = await api.projects();
  setProjects(list.items);
  const stored = localStorage.getItem("devteam.project");
  const id = list.items.find((p) => p.id === stored)?.id ?? list.items[0]?.id ?? null;
  if (id) await loadProject(id);
}

export async function login(email: string, password: string): Promise<void> {
  const result = await api.login(email, password);
  setDemoMode(result.user.demoMode);
  await loadWorkspace();
  setAuthUser(result.user);
  setAuthChecked(true);
}

export async function register(input: {
  email: string;
  password: string;
  displayName: string;
  inviteCode: string;
}): Promise<void> {
  const result = await api.register(input);
  setDemoMode(result.user.demoMode);
  await loadWorkspace();
  setAuthUser(result.user);
  setAuthChecked(true);
}

export async function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<boolean> {
  try {
    await api.changePassword(currentPassword, newPassword);
    toast("密码已更新，其他登录会话已退出。");
    return true;
  } catch (err) {
    toast(messageOf(err));
    return false;
  }
}

export async function logout(): Promise<void> {
  try {
    await api.logout();
  } catch {
    // clearing local state is still the right move
  }
  setAuthUser(null);
  setDemoMode(false);
  closeStream();
  resetCodeState();
  setProjects([]);
  setSnapshot(null);
  setMessages([]);
  setCurrentId(null);
  setSelectedArtifact(null);
  setThinking([]);
  setRoomReading(false);
  localStorage.removeItem("devteam.project");
}

export async function reloadProjects(): Promise<void> {
  try {
    const list = await api.projects();
    setProjects(list.items);
  } catch (err) {
    toast(messageOf(err));
  }
}

export async function loadProject(id: string): Promise<void> {
  const token = ++projectLoadToken;
  closeStream();
  setLoading(true);
  setAutoStartError(null);
  setCurrentId(id);
  setSelectedArtifact(null);
  resetCodeState();
  setDecisionOpen(false);
  lastPendingDecisionCount = 0;
  setThinking([]);
  setRoomReading(false);
  setPresence([]);
  localStorage.setItem("devteam.project", id);
  try {
    const [snap, page] = await Promise.all([api.snapshot(id), api.messages(id)]);
    // A newer project click may have completed while this request was in
    // flight. Never let an older response overwrite the active project.
    if (token !== projectLoadToken) return;
    applySnapshot(snap);
    setMessages(page.items);
    setRuns(snap.runs);
    lastEventSeq = snap.eventCursor ?? 0;
    connect(id);
    if (view() === "code") void loadCodeView();
  } catch (err) {
    if (token !== projectLoadToken) return;
    if (!(err instanceof ApiError && err.status === 401)) toast(messageOf(err));
  } finally {
    if (token === projectLoadToken) setLoading(false);
  }
}

export async function sendMessage(content: string, mentions?: string[]): Promise<void> {
  const id = currentId();
  if (!id || !content.trim()) return;
  setSending(true);
  try {
    const message = await api.postMessage(
      id,
      content.trim(),
      mentions,
      turnParticipants() ?? undefined,
    );
    setMessages((prev) => mergeMessages(prev, [message]));
    setTurnParticipants(null);
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 401)) toast(messageOf(err));
  } finally {
    setSending(false);
  }
}

export async function stopRun(): Promise<void> {
  const id = currentId();
  if (!id) return;
  try {
    await api.stop(id);
    setThinking([]);
    setRoomReading(false);
  } catch (err) {
    toast(messageOf(err));
  }
}

export async function openArtifact(artifactId: string): Promise<void> {
  const id = currentId();
  if (!id) return;
  try {
    setSelectedArtifact(await api.artifact(id, artifactId));
  } catch (err) {
    toast(messageOf(err));
  }
}

export function closeArtifact(): void {
  setSelectedArtifact(null);
}

function resetCodeState(): void {
  codeLoadToken += 1;
  setWorkspaces([]);
  setActiveWorkspaceId(null);
  setCodeFiles([]);
  setSelectedFilePath(null);
  setSelectedFileContent(null);
  setCodeDiff("");
  setCodeTestRuns([]);
  setCodeSource("repo");
  setCodeError("");
}

export async function loadCodeView(): Promise<void> {
  const id = currentId();
  if (!id) return;
  const token = ++codeLoadToken;
  const isCurrent = () => token === codeLoadToken && currentId() === id;
  setCodeLoading(true);
  setCodeError("");
  try {
    let list: WorkspaceItem[] = [];
    try {
      list = (await api.projectWorkspaces(id)).items;
    } catch (err) {
      if (err instanceof ApiError && (err.code === "DEMO_MODE" || err.status === 403)) {
        if (isCurrent()) {
          setWorkspaces([]);
          setCodeError("演示模式已禁用代码工作区。");
        }
        return;
      }
      throw err;
    }
    if (!isCurrent()) return;
    setWorkspaces(list);
    const saved = activeWorkspaceId();
    const active = (saved && list.some((item) => item.id === saved) ? saved : list[0]?.id) ?? null;
    setActiveWorkspaceId(active);
    const source = codeSource() === "workspace" && !active ? "repo" : codeSource();
    setCodeSource(source);

    if (source === "workspace" && active) {
      const files = await api.workspaceFiles(active);
      if (!isCurrent()) return;
      setCodeFiles(files.items);
      if (codeTab() === "diff") {
        const diff = await api.workspaceDiff(active);
        if (!isCurrent()) return;
        setCodeDiff(diff.diff);
      }
      if (codeTab() === "tests") {
        const runs = await api.workspaceTestRuns(active);
        if (!isCurrent()) return;
        setCodeTestRuns(runs.items);
      }
    } else {
      try {
        const files = await api.repoFiles(id);
        if (!isCurrent()) return;
        setCodeFiles(files.items);
      } catch (err) {
        if (!isCurrent()) return;
        setCodeFiles([]);
        if (err instanceof ApiError && err.code === "REPO_NOT_CONFIGURED") {
          setCodeError("这个项目还没有配置仓库路径。");
        } else if (err instanceof ApiError && err.code === "REPO_PATH_INVALID") {
          setCodeError(err.message);
        } else if (err instanceof ApiError && (err.code === "DEMO_MODE" || err.status === 403)) {
          setCodeError("演示模式已禁用代码浏览。");
        } else if (!(err instanceof ApiError && err.status === 401)) {
          toast(messageOf(err));
        }
      }
      setCodeDiff("");
      setCodeTestRuns([]);
    }

    if (!isCurrent()) return;

    const current = selectedFilePath();
    if (current && codeFiles().some((file) => file.path === current)) {
      await loadCodeFile(current);
    } else {
      const first = codeFiles()[0]?.path ?? null;
      setSelectedFilePath(first);
      setSelectedFileContent(null);
      if (first) await loadCodeFile(first);
    }
  } catch (err) {
    if (isCurrent() && !(err instanceof ApiError && err.status === 401)) toast(messageOf(err));
  } finally {
    if (isCurrent()) setCodeLoading(false);
  }
}

export async function loadCodeFile(path: string): Promise<void> {
  const id = currentId();
  if (!id) return;
  const token = codeLoadToken;
  const source = codeSource();
  const workspaceId = activeWorkspaceId();
  try {
    if (source === "workspace" && workspaceId) {
      const result = await api.workspaceFile(workspaceId, path);
      if (
        token !== codeLoadToken ||
        currentId() !== id ||
        codeSource() !== source ||
        activeWorkspaceId() !== workspaceId
      ) {
        return;
      }
      setSelectedFilePath(path);
      setSelectedFileContent(result.content);
    } else {
      const result = await api.repoFile(id, path);
      if (token !== codeLoadToken || currentId() !== id || codeSource() !== source) {
        return;
      }
      setSelectedFilePath(path);
      setSelectedFileContent(result.content);
    }
  } catch (err) {
    if (token !== codeLoadToken) return;
    if (!(err instanceof ApiError && err.status === 401)) toast(messageOf(err));
  }
}

export function selectCodeFile(path: string): void {
  void loadCodeFile(path);
}

export async function verifyCodeWorkspace(): Promise<boolean> {
  const workspaceId = activeWorkspaceId();
  if (!workspaceId) return false;
  try {
    await api.verifyWorkspace(workspaceId);
    toast("已排入核对队列；完成后会更新测试、规格核对和任务状态。");
    return true;
  } catch (err) {
    toast(messageOf(err));
    return false;
  }
}

export async function openTaskPullRequest(task: Task): Promise<boolean> {
  const workspaceId =
    typeof task.evidence?.["workspaceId"] === "string"
      ? (task.evidence["workspaceId"] as string)
      : null;
  if (!workspaceId) {
    toast("这个任务没有可推送的代码工作区。");
    return false;
  }
  try {
    const result = await api.openPullRequest(workspaceId);
    await refreshSnapshot();
    if (result.pullRequest) {
      toast(`已创建 PR #${result.pullRequest.number}：${result.pullRequest.url}`);
    } else {
      toast(result.warning ?? `已推送分支 ${result.branch}。`);
    }
    return true;
  } catch (err) {
    toast(messageOf(err));
    return false;
  }
}

export async function mergeTaskWorkspace(task: Task): Promise<boolean> {
  const workspaceId =
    typeof task.evidence?.["workspaceId"] === "string"
      ? (task.evidence["workspaceId"] as string)
      : null;
  if (!workspaceId) {
    toast("这个任务没有可合并的代码工作区。");
    return false;
  }
  if (task.status !== "review") {
    toast("任务还没有完成验证；等它进入 review 后再验收合并。");
    return false;
  }
  const verification = task.evidence?.["verification"] as { verdict?: string } | undefined;
  if (verification?.verdict !== "pass") {
    toast("规格核对还没有通过，不能验收合并。");
    return false;
  }
  try {
    const result = await api.mergeWorkspace(workspaceId);
    await refreshSnapshot();
    if (view() === "code") void loadCodeView();
    toast(`已合并到 ${result.baseBranch}（${result.commit.slice(0, 8)}）。`);
    return true;
  } catch (err) {
    toast(messageOf(err));
    return false;
  }
}

export async function cancelCodeWorkspace(): Promise<boolean> {
  const workspaceId = activeWorkspaceId();
  if (!workspaceId) return false;
  try {
    await api.cancelWorkspace(workspaceId);
    await refreshSnapshot();
    toast("已请求停止当前代码运行，工作区会保留。");
    return true;
  } catch (err) {
    toast(messageOf(err));
    return false;
  }
}

export async function saveCodeFile(path: string, content: string): Promise<boolean> {
  const workspaceId = activeWorkspaceId();
  if (!workspaceId) return false;
  try {
    const result = await api.writeWorkspaceFile(workspaceId, path, content);
    await loadCodeFile(path);
    await refreshSnapshot();
    if (view() === "code") void loadCodeView();
    toast(
      result.taskReopened
        ? "文件已保存。任务已回到进行中，需要重新运行测试与规格核对。"
        : "文件已保存。",
    );
    return true;
  } catch (err) {
    toast(messageOf(err));
    return false;
  }
}

export async function saveProjectSettings(patch: {
  name?: string;
  description?: string;
  repoPath?: string | null;
  repoUrl?: string | null;
  defaultBranch?: string;
  budgetCents?: number;
  status?: "active" | "archived";
  autoStartTasks?: boolean;
  expectedVersion?: number;
}): Promise<boolean> {
  const id = currentId();
  if (!id) return false;
  try {
    const next = await api.patchProject(id, patch);
    setSnapshot(next);
    await reloadProjects();
    setSettingsOpen(false);
    resetCodeState();
    if (view() === "code") void loadCodeView();
    toast("项目设置已保存。");
    return true;
  } catch (err) {
    toast(messageOf(err));
    return false;
  }
}

export function selectCodeSource(source: "repo" | "workspace"): void {
  setCodeSource(source);
  setSelectedFilePath(null);
  setSelectedFileContent(null);
  setCodeDiff("");
  setCodeTestRuns([]);
  void loadCodeView();
}

export function selectWorkspace(workspaceId: string): void {
  setActiveWorkspaceId(workspaceId);
  setCodeSource("workspace");
  setSelectedFilePath(null);
  setSelectedFileContent(null);
  setCodeDiff("");
  setCodeTestRuns([]);
  void loadCodeView();
}

export function selectCodeTab(tab: "files" | "diff" | "tests" | "terminal"): void {
  setCodeTab(tab);
  const workspaceId = activeWorkspaceId();
  const projectId = currentId();
  if (!workspaceId || !projectId) return;
  const token = codeLoadToken;
  const isCurrent = () =>
    token === codeLoadToken &&
    currentId() === projectId &&
    activeWorkspaceId() === workspaceId &&
    codeTab() === tab;
  if (tab === "diff") {
    void api
      .workspaceDiff(workspaceId)
      .then((result) => {
        if (isCurrent()) setCodeDiff(result.diff);
      })
      .catch((err) => {
        if (isCurrent()) toast(messageOf(err));
      });
  }
  if (tab === "tests") {
    void api
      .workspaceTestRuns(workspaceId)
      .then((result) => {
        if (isCurrent()) setCodeTestRuns(result.items);
      })
      .catch((err) => {
        if (isCurrent()) toast(messageOf(err));
      });
  }
}

export async function openWorkspace(
  workspaceId: string,
  tab: "files" | "diff" | "tests" | "terminal" = "diff",
): Promise<void> {
  setView("code");
  setRightOpen(false);
  setActiveWorkspaceId(workspaceId);
  setCodeSource("workspace");
  setCodeTab(tab);
  setSelectedFilePath(null);
  setSelectedFileContent(null);
  await loadCodeView();
}

export function openTaskCode(task: Task): void {
  const workspaceId =
    typeof task.evidence?.["workspaceId"] === "string"
      ? (task.evidence["workspaceId"] as string)
      : null;
  if (workspaceId) {
    void openWorkspace(workspaceId, "diff");
    return;
  }
  const diffArtifactId =
    typeof task.evidence?.["diffArtifactId"] === "string"
      ? (task.evidence["diffArtifactId"] as string)
      : null;
  if (diffArtifactId) {
    void openArtifact(diffArtifactId);
    return;
  }
  setView("code");
  setRightOpen(false);
  void loadCodeView();
}

export async function resumeAutoDevelopment(): Promise<void> {
  const id = currentId();
  if (!id) return;
  setAutoStartError(null);
  try {
    const snap = await api.startAutoDevelopment(id);
    applySnapshot(snap);
    setAutoStartError(null);
    setDecisionOpen(false);
    toast("自动开发已继续。");
  } catch (err) {
    const message = messageOf(err);
    setAutoStartError(message);
    toast(message);
  }
}

export async function acceptPendingTechnicalArtifacts(): Promise<void> {
  const id = currentId();
  if (!id) return;
  try {
    const result = await api.acceptPendingArtifacts(id);
    await refreshSnapshot();
    toast(
      result.accepted
        ? `已接受 ${result.accepted} 项技术产物。`
        : "没有可批量接受的技术产物。",
    );
  } catch (err) {
    toast(messageOf(err));
  }
}

export async function decideArtifact(
  artifactId: string,
  status: "accepted" | "rejected",
): Promise<void> {
  const id = currentId();
  if (!id) return;
  try {
    await api.decideArtifact(id, artifactId, status);
    await refreshSnapshot();
    if (selectedArtifact()?.id === artifactId) {
      setSelectedArtifact(await api.artifact(id, artifactId));
    }
  } catch (err) {
    toast(messageOf(err));
  }
}

export async function decideApproval(
  approvalId: string,
  status: "approved" | "rejected",
): Promise<void> {
  const id = currentId();
  if (!id) return;
  try {
    await api.decideApproval(id, approvalId, status);
    await refreshSnapshot();
  } catch (err) {
    toast(messageOf(err));
  }
}

export async function decideDecision(
  decisionId: string,
  status: "accepted" | "rejected",
): Promise<void> {
  const id = currentId();
  if (!id) return;
  try {
    await api.decideDecision(id, decisionId, status);
    await refreshSnapshot();
  } catch (err) {
    toast(messageOf(err));
  }
}

export async function advancePhase(force = false, note?: string): Promise<boolean> {
  const id = currentId();
  if (!id) return false;
  try {
    const snap = await api.advance(id, { force, note });
    setSnapshot(snap);
    setGateError(null);
    return true;
  } catch (err) {
    if (err instanceof ApiError && err.code === "PHASE_GATE_NOT_MET") {
      const details = err.details as { requirements?: PhaseRequirement[] } | undefined;
      setGateError(details?.requirements ?? []);
    } else {
      toast(messageOf(err));
    }
    return false;
  }
}

export function requestAdvance(): void {
  const snap = snapshot();
  if (!snap) return;
  if (snap.canAdvance) void advancePhase();
  else setGateError(snap.phaseRequirements);
}

export async function updateTask(taskId: string, patch: Record<string, unknown>): Promise<boolean> {
  const id = currentId();
  if (!id) return false;
  try {
    await api.patchTask(id, taskId, patch);
    await refreshSnapshot();
    return true;
  } catch (err) {
    toast(messageOf(err));
    await refreshSnapshot();
    return false;
  }
}

export async function loadTaskDependencies(taskId: string): Promise<string[]> {
  const id = currentId();
  if (!id) return [];
  try {
    const result = await api.taskDependencies(id, taskId);
    return result.items.map((item) => item.dependsOnTaskId);
  } catch (err) {
    toast(messageOf(err));
    return [];
  }
}

export async function saveTaskDependencies(
  taskId: string,
  dependsOnTaskIds: string[],
): Promise<boolean> {
  const id = currentId();
  if (!id) return false;
  try {
    const current = await api.taskDependencies(id, taskId);
    const existing = new Set(current.items.map((item) => item.dependsOnTaskId));
    const desired = new Set(dependsOnTaskIds);
    for (const dependencyId of desired) {
      if (!existing.has(dependencyId)) {
        await api.addTaskDependency(id, taskId, dependencyId);
      }
    }
    for (const dependencyId of existing) {
      if (!desired.has(dependencyId)) {
        await api.removeTaskDependency(id, taskId, dependencyId);
      }
    }
    await refreshSnapshot();
    toast("任务依赖已保存。");
    return true;
  } catch (err) {
    toast(messageOf(err));
    return false;
  }
}

export async function deleteTask(taskId: string): Promise<boolean> {
  const id = currentId();
  if (!id) return false;
  try {
    await api.deleteTask(id, taskId);
    await refreshSnapshot();
    if (view() === "code") void loadCodeView();
    toast("任务已删除，相关代码工作区已清理。");
    return true;
  } catch (err) {
    toast(messageOf(err));
    return false;
  }
}

export async function deleteProject(): Promise<boolean> {
  const id = currentId();
  if (!id) return false;
  try {
    await api.deleteProject(id);
    setSettingsOpen(false);
    closeStream();
    resetCodeState();
    setSelectedArtifact(null);
    setSnapshot(null);
    setMessages([]);
    setRuns([]);
    setThinking([]);
    setRoomReading(false);
    setCurrentId(null);
    setRightOpen(false);
    setView("chat");
    localStorage.removeItem("devteam.project");
    const list = await api.projects();
    setProjects(list.items);
    if (list.items[0]) await loadProject(list.items[0].id);
    toast("项目已删除。");
    return true;
  } catch (err) {
    toast(messageOf(err));
    return false;
  }
}

export async function toggleRoleInRoom(roleKey: string, inRoom: boolean): Promise<void> {
  const id = currentId();
  if (!id) return;
  try {
    await api.updateRole(id, roleKey, { inRoom });
    await refreshSnapshot();
  } catch (err) {
    toast(messageOf(err));
  }
}

export async function startTaskWork(taskId: string): Promise<void> {  const id = currentId();
  if (!id) return;
  setWorkingTaskId(taskId);
  try {
    await api.startTaskWork(id, taskId);
    toast("已启动代码任务：Agent 会在隔离 worktree 中实现并跑测试。");
    await refreshSnapshot();
  } catch (err) {
    toast(messageOf(err));
  } finally {
    window.setTimeout(() => setWorkingTaskId(null), 2500);
  }
}

export async function createProject(
  name: string,
  description: string,
  repoPath?: string,
): Promise<void> {
  try {
    const snap = await api.createProject({
      name,
      description,
      repoPath: repoPath?.trim() || undefined,
    });
    await reloadProjects();
    setCreateOpen(false);
    await loadProject(snap.project.id);
  } catch (err) {
    toast(messageOf(err));
  }
}

export async function createTask(input: {
  title: string;
  description?: string;
  roleKey?: string;
  priority?: string;
  acceptance?: string[];
}): Promise<void> {
  const id = currentId();
  if (!id) return;
  try {
    await api.createTask(id, input);
    await refreshSnapshot();
  } catch (err) {
    toast(messageOf(err));
  }
}

export function switchView(next: ViewKey): void {
  setView(next);
  if (next === "activity") void refreshRuns();
  if (next === "admin") {
    setRightOpen(false);
    void loadAdmin();
  }
  if (next === "code") {
    setRightOpen(false);
    void loadCodeView();
  }
}

export function canEditCurrentProject(): boolean {
  const id = currentId();
  if (!id) return false;
  const role = projects().find((project) => project.id === id)?.membershipRole;
  return role === "owner" || role === "member";
}

export function isCurrentProjectOwner(): boolean {
  const id = currentId();
  if (!id) return false;
  return projects().find((project) => project.id === id)?.membershipRole === "owner";
}

export async function loadAdmin(): Promise<void> {
  if (!authUser()?.isAdmin) return;
  setAdminLoading(true);
  try {
    const [stats, users, projects, invites] = await Promise.all([
      api.adminStats(),
      api.adminUsers(),
      api.adminProjects(),
      api.adminInvites(),
    ]);
    setAdminStats(stats);
    setAdminUsers(users.items);
    setAdminProjects(projects.items);
    setAdminInvites(invites.items);
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 401)) toast(messageOf(err));
  } finally {
    setAdminLoading(false);
  }
}

export async function adminUpdateUser(
  userId: string,
  patch: { isActive?: boolean; isAdmin?: boolean },
): Promise<void> {
  try {
    await api.adminUpdateUser(userId, patch);
    await loadAdmin();
  } catch (err) {
    toast(messageOf(err));
  }
}

export async function adminResetPassword(userId: string, password: string): Promise<void> {
  try {
    await api.adminResetPassword(userId, password);
    toast("密码已更新。");
  } catch (err) {
    toast(messageOf(err));
  }
}

export async function adminDeleteUser(userId: string): Promise<void> {
  try {
    await api.adminDeleteUser(userId);
    await loadAdmin();
  } catch (err) {
    toast(messageOf(err));
  }
}

export async function adminDeleteProject(projectId: string): Promise<void> {
  try {
    await api.adminDeleteProject(projectId);
    await loadAdmin();
  } catch (err) {
    toast(messageOf(err));
  }
}

export async function adminCreateInvite(input: {
  label?: string;
  maxUses?: number;
  expiresInDays?: number;
}): Promise<void> {
  try {
    await api.adminCreateInvite(input);
    await loadAdmin();
  } catch (err) {
    toast(messageOf(err));
  }
}

export async function adminRevokeInvite(inviteId: string): Promise<void> {
  try {
    await api.adminRevokeInvite(inviteId);
    await loadAdmin();
  } catch (err) {
    toast(messageOf(err));
  }
}

export function openRight(tab: RightTab): void {
  setRightTab(tab);
  setRightOpen(true);
}
