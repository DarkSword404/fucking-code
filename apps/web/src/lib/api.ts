import type {
  AgentRole,
  AgentRun,
  Approval,
  Artifact,
  ArtifactWithContent,
  Decision,
  Memory,
  Message,
  Project,
  ProjectMember,
  ProjectSnapshot,
  Task,
  WorkflowPhase,
} from "@devteam/contracts";

const BASE = "/api/v1";

export type ProjectListItem = Project & { membershipRole: string };

export interface AuthUser {
  id: string;
  tenantId: string;
  email: string;
  displayName: string;
  authMode: string;
  demoMode: boolean;
  isAdmin: boolean;
}

export interface AdminStats {
  users: number;
  activeUsers: number;
  projects: number;
  messages: number;
  messagesToday: number;
  runsToday: number;
  activeInvites: number;
}

export interface AdminUser {
  id: string;
  tenantId: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
  isActive: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  projectCount: number;
  messageCount: number;
}

export interface AdminProject {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  phase: string;
  status: string;
  repoUrl: string | null;
  repoPath: string | null;
  createdAt: string;
  updatedAt: string;
  owner: { email: string; displayName: string } | null;
  taskCount: number;
  artifactCount: number;
  messageCount: number;
}

export interface AdminInvite {
  id: string;
  code: string;
  label: string;
  createdBy: string | null;
  maxUses: number;
  uses: number;
  expiresAt: string | null;
  active: boolean;
  createdAt: string;
}

export interface WorkspaceItem {
  id: string;
  projectId: string;
  taskId: string | null;
  path: string;
  branch: string;
  baseCommit: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface FileEntry {
  path: string;
  status: string;
}

export interface TestRunItem {
  id: string;
  command: string;
  exitCode: number | null;
  status: string;
  output: string;
  durationMs: number | null;
  createdAt: string;
}

export interface AuthConfig {
  authMode: string;
  registrationEnabled: boolean;
  demoMode: boolean;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public code: string,
    public status: number,
    public details?: unknown,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as
      | { error?: { code?: string; message?: string; details?: unknown } }
      | null;
    if (
      res.status === 401 &&
      !path.startsWith("/auth/") &&
      typeof window !== "undefined"
    ) {
      window.dispatchEvent(new Event("devteam:unauthorized"));
    }
    throw new ApiError(
      body?.error?.message ?? `Request failed (${res.status})`,
      body?.error?.code ?? "REQUEST_FAILED",
      res.status,
      body?.error?.details,
    );
  }
  return (await res.json()) as T;
}

export const api = {
  authConfig: () => request<AuthConfig>("/auth/config"),
  login: (email: string, password: string) =>
    request<{ user: AuthUser; authMode: string }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  register: (input: {
    email: string;
    password: string;
    displayName: string;
    inviteCode: string;
  }) =>
    request<{ user: AuthUser; projectId: string; authMode: string }>("/auth/register", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  logout: () => request<{ ok: boolean }>("/auth/logout", { method: "POST" }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: boolean }>("/me/password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
  me: () => request<AuthUser>("/me"),
  runtime: () => request<{ name: string; model: { provider: string; id: string } }>("/runtime"),
  projects: () => request<{ items: ProjectListItem[] }>("/projects"),
  createProject: (input: { name: string; description?: string; repoUrl?: string; repoPath?: string }) =>
    request<ProjectSnapshot>("/projects", { method: "POST", body: JSON.stringify(input) }),
  snapshot: (id: string) => request<ProjectSnapshot>(`/projects/${id}`),
  projectMembers: (id: string) =>
    request<{ items: ProjectMember[] }>(`/projects/${id}/members`),
  addProjectMember: (id: string, email: string, role: ProjectMember["role"]) =>
    request<ProjectMember>(`/projects/${id}/members`, {
      method: "POST",
      body: JSON.stringify({ email, role }),
    }),
  updateProjectMember: (id: string, userId: string, role: ProjectMember["role"]) =>
    request<ProjectMember>(`/projects/${id}/members/${userId}`, {
      method: "PATCH",
      body: JSON.stringify({ role }),
    }),
  removeProjectMember: (id: string, userId: string) =>
    request<{ ok: boolean }>(`/projects/${id}/members/${userId}`, { method: "DELETE" }),
  projectMemories: (id: string) => request<{ items: Memory[] }>(`/projects/${id}/memories`),
  createMemory: (id: string, input: { type: string; title: string; content: string }) =>
    request<Memory>(`/projects/${id}/memories`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateMemory: (
    id: string,
    memoryId: string,
    patch: Partial<Pick<Memory, "type" | "title" | "content" | "status">>,
  ) =>
    request<Memory>(`/projects/${id}/memories/${memoryId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteMemory: (id: string, memoryId: string) =>
    request<{ ok: boolean }>(`/projects/${id}/memories/${memoryId}`, { method: "DELETE" }),
  deleteProject: (id: string) =>
    request<{ ok: boolean }>(`/projects/${id}`, { method: "DELETE" }),
  messages: (id: string, cursor?: string) =>
    request<{ items: Message[]; nextCursor: string | null }>(
      `/projects/${id}/messages${cursor ? `?cursor=${cursor}` : ""}`,
    ),
  postMessage: (id: string, content: string, mentions?: string[], participants?: string[]) =>
    request<Message>(`/projects/${id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content, mentions, participants }),
    }),
  updateRole: (projectId: string, roleKey: string, patch: { inRoom?: boolean; enabled?: boolean }) =>
    request<AgentRole>(`/projects/${projectId}/roles/${roleKey}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  stop: (id: string) => request<{ stopped: boolean }>(`/projects/${id}/stop`, { method: "POST" }),
  tasks: (id: string) => request<{ items: Task[] }>(`/projects/${id}/tasks`),
  createTask: (
    projectId: string,
    input: {
      title: string;
      description?: string;
      roleKey?: string;
      priority?: string;
      acceptance?: string[];
    },
  ) =>
    request<Task>(`/projects/${projectId}/tasks`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  patchTask: (projectId: string, taskId: string, patch: Record<string, unknown>) =>
    request<Task>(`/projects/${projectId}/tasks/${taskId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteTask: (projectId: string, taskId: string) =>
    request<{ ok: boolean }>(`/projects/${projectId}/tasks/${taskId}`, { method: "DELETE" }),
  taskDependencies: (projectId: string, taskId: string) =>
    request<{
      items: Array<{ taskId: string; dependsOnTaskId: string; title: string; status: string }>;
    }>(`/projects/${projectId}/tasks/${taskId}/dependencies`),
  addTaskDependency: (projectId: string, taskId: string, dependsOnTaskId: string) =>
    request<{ ok: boolean }>(`/projects/${projectId}/tasks/${taskId}/dependencies`, {
      method: "POST",
      body: JSON.stringify({ dependsOnTaskId }),
    }),
  removeTaskDependency: (projectId: string, taskId: string, dependsOnTaskId: string) =>
    request<{ ok: boolean }>(
      `/projects/${projectId}/tasks/${taskId}/dependencies/${dependsOnTaskId}`,
      { method: "DELETE" },
    ),
  artifacts: (id: string) => request<{ items: Artifact[] }>(`/projects/${id}/artifacts`),
  artifact: (projectId: string, artifactId: string) =>
    request<ArtifactWithContent>(`/projects/${projectId}/artifacts/${artifactId}`),
  decideArtifact: (projectId: string, artifactId: string, status: "accepted" | "rejected", note?: string) =>
    request<Artifact>(`/projects/${projectId}/artifacts/${artifactId}/decision`, {
      method: "POST",
      body: JSON.stringify({ status, note }),
    }),
  decisions: (id: string) => request<{ items: Decision[] }>(`/projects/${id}/decisions`),
  decideDecision: (projectId: string, decisionId: string, status: "accepted" | "rejected") =>
    request<Decision>(`/projects/${projectId}/decisions/${decisionId}/decide`, {
      method: "POST",
      body: JSON.stringify({ status }),
    }),
  approvals: (id: string) => request<{ items: Approval[] }>(`/projects/${id}/approvals`),
  decideApproval: (projectId: string, approvalId: string, status: "approved" | "rejected", reason?: string) =>
    request<Approval>(`/projects/${projectId}/approvals/${approvalId}/decide`, {
      method: "POST",
      body: JSON.stringify({ status, reason }),
    }),
  advance: (id: string, input: { to?: WorkflowPhase; note?: string; force?: boolean }) =>
    request<ProjectSnapshot>(`/projects/${id}/advance`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  runs: (id: string) =>
    request<{ items: AgentRun[] }>(`/projects/${id}/runs`),
  startTaskWork: (projectId: string, taskId: string) =>
    request<{ workspace: { id: string; path: string; branch: string }; queued: boolean }>(
      `/projects/${projectId}/tasks/${taskId}/work`,
      { method: "POST" },
    ),
  workspaceDiff: (workspaceId: string) =>
    request<{ diff: string }>(`/workspaces/${workspaceId}/diff`),
  workspaceFiles: (workspaceId: string) =>
    request<{ items: FileEntry[] }>(`/workspaces/${workspaceId}/files`),
  workspaceFile: (workspaceId: string, path: string) =>
    request<{ path: string; content: string }>(
      `/workspaces/${workspaceId}/file?path=${encodeURIComponent(path)}`,
    ),
  writeWorkspaceFile: (workspaceId: string, path: string, content: string) =>
    request<{ path: string; taskReopened: boolean }>(`/workspaces/${workspaceId}/file`, {
      method: "PUT",
      body: JSON.stringify({ path, content }),
    }),
  workspaceTestRuns: (workspaceId: string) =>
    request<{ items: TestRunItem[] }>(`/workspaces/${workspaceId}/test-runs`),
  verifyWorkspace: (workspaceId: string) =>
    request<{ queued: boolean }>(`/workspaces/${workspaceId}/verify`, { method: "POST" }),
  cancelWorkspace: (workspaceId: string) =>
    request<{ cancelled: boolean }>(`/workspaces/${workspaceId}/cancel`, { method: "POST" }),
  runWorkspaceCommand: (workspaceId: string, command: string) =>
    request<{
      command: string;
      exitCode: number | null;
      status: string;
      output: string;
      durationMs: number;
      testRunId: string;
    }>(`/workspaces/${workspaceId}/commands`, {
      method: "POST",
      body: JSON.stringify({ command }),
    }),
  mergeWorkspace: (workspaceId: string) =>
    request<{ commit: string; branch: string; baseBranch: string }>(
      `/workspaces/${workspaceId}/merge`,
      { method: "POST" },
    ),
  openPullRequest: (workspaceId: string) =>
    request<{
      commit: string;
      branch: string;
      remote: string;
      pullRequest: { url: string; number: number } | null;
      warning: string | null;
    }>(`/workspaces/${workspaceId}/pull-request`, { method: "POST" }),
  projectWorkspaces: (projectId: string) =>
    request<{ items: WorkspaceItem[] }>(`/projects/${projectId}/workspaces`),
  repoFiles: (projectId: string) =>
    request<{ items: FileEntry[] }>(`/projects/${projectId}/repo/files`),
  repoFile: (projectId: string, path: string) =>
    request<{ path: string; content: string }>(
      `/projects/${projectId}/repo/file?path=${encodeURIComponent(path)}`,
    ),
  patchProject: (
    projectId: string,
    patch: {
      name?: string;
      description?: string;
      repoPath?: string | null;
      repoUrl?: string | null;
      defaultBranch?: string;
      budgetCents?: number;
    },
  ) =>
    request<ProjectSnapshot>(`/projects/${projectId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  adminStats: () => request<AdminStats>("/admin/stats"),
  adminUsers: () => request<{ items: AdminUser[] }>("/admin/users"),
  adminProjects: () => request<{ items: AdminProject[] }>("/admin/projects"),
  adminInvites: () => request<{ items: AdminInvite[] }>("/admin/invites"),
  adminUpdateUser: (userId: string, patch: { isActive?: boolean; isAdmin?: boolean }) =>
    request<AdminUser>(`/admin/users/${userId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  adminResetPassword: (userId: string, password: string) =>
    request<{ ok: boolean }>(`/admin/users/${userId}/password`, {
      method: "POST",
      body: JSON.stringify({ password }),
    }),
  adminDeleteUser: (userId: string) =>
    request<{ ok: boolean }>(`/admin/users/${userId}`, { method: "DELETE" }),
  adminDeleteProject: (projectId: string) =>
    request<{ ok: boolean }>(`/admin/projects/${projectId}`, { method: "DELETE" }),
  adminCreateInvite: (input: {
    label?: string;
    maxUses?: number;
    expiresInDays?: number;
  }) =>
    request<AdminInvite>("/admin/invites", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  adminRevokeInvite: (inviteId: string) =>
    request<{ ok: boolean }>(`/admin/invites/${inviteId}`, { method: "DELETE" }),
};
