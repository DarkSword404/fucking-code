import { For, Show, createSignal } from "solid-js";
import type { Task } from "@devteam/contracts";
import {
  createTask,
  deleteTask,
  demoMode,
  isTaskRunning,
  loadTaskDependencies,
  mergeTaskWorkspace,
  openTaskCode,
  openTaskPullRequest,
  projects,
  snapshot,
  saveTaskDependencies,
  startTaskWork,
  updateTask,
  workingTaskId,
} from "../lib/store";

const GROUPS = [
  { key: "todo", label: "待办", statuses: ["proposed", "ready", "needs_replan", "stale"] },
  { key: "doing", label: "进行中", statuses: ["in_progress", "blocked"] },
  { key: "review", label: "评审 / 测试", statuses: ["review", "testing"] },
  { key: "done", label: "完成", statuses: ["done", "cancelled", "failed"] },
] as const;

const STATUS_OPTIONS = [
  "proposed",
  "ready",
  "in_progress",
  "blocked",
  "review",
  "testing",
  "done",
  "failed",
  "cancelled",
  "needs_replan",
  "stale",
];

const PRIORITY_COLOR: Record<string, string> = {
  low: "#64748b",
  medium: "#7dd3fc",
  high: "#f5b544",
  critical: "#f87171",
};

export function TasksView() {
  const [newOpen, setNewOpen] = createSignal(false);
  const [search, setSearch] = createSignal("");
  const [title, setTitle] = createSignal("");
  const [desc, setDesc] = createSignal("");
  const [role, setRole] = createSignal("backend");
  const [acceptance, setAcceptance] = createSignal("");
  const [pendingDelete, setPendingDelete] = createSignal<Task | null>(null);
  const [deleting, setDeleting] = createSignal(false);
  const [editingTask, setEditingTask] = createSignal<Task | null>(null);
  const [editTitle, setEditTitle] = createSignal("");
  const [editDesc, setEditDesc] = createSignal("");
  const [editRole, setEditRole] = createSignal("");
  const [editPriority, setEditPriority] = createSignal("medium");
  const [editAcceptance, setEditAcceptance] = createSignal("");
  const [savingEdit, setSavingEdit] = createSignal(false);
  const [pendingMerge, setPendingMerge] = createSignal<Task | null>(null);
  const [merging, setMerging] = createSignal(false);
  const [pendingDeps, setPendingDeps] = createSignal<Task | null>(null);
  const [depIds, setDepIds] = createSignal<string[]>([]);
  const [depLoading, setDepLoading] = createSignal(false);
  const [savingDeps, setSavingDeps] = createSignal(false);

  const allTasks = () => snapshot()?.tasks ?? [];
  const tasks = () => {
    const query = search().trim().toLowerCase();
    if (!query) return allTasks();
    return allTasks().filter((task) =>
      `${task.title} ${task.description} ${task.status} ${task.priority} ${task.roleKey ?? ""}`
        .toLowerCase()
        .includes(query),
    );
  };
  const canEdit = () => {
    const id = snapshot()?.project.id;
    if (!id) return false;
    const role = projects().find((project) => project.id === id)?.membershipRole;
    return role === "owner" || role === "member";
  };
  const canEditTask = (task: Task) =>
    canEdit() && !["done", "cancelled"].includes(task.status) && !isTaskRunning(task.id);
  const roleOf = (task: Task) => snapshot()?.roles.find((r) => r.key === task.roleKey);
  const hasRepo = () => Boolean(snapshot()?.project.repoPath);
  const hasSpec = (task: Task) =>
    Boolean((task.spec as { prd?: unknown } | undefined)?.prd);
  const diffId = (task: Task): string | null =>
    typeof task.evidence?.["diffArtifactId"] === "string" ? (task.evidence["diffArtifactId"] as string) : null;
  const mergeable = (task: Task) => {
    const verification = task.evidence?.["verification"] as { verdict?: string } | undefined;
    return (
      canEditTask(task) &&
      task.status === "review" &&
      typeof task.evidence?.["workspaceId"] === "string" &&
      verification?.verdict === "pass" &&
      !isTaskRunning(task.id)
    );
  };
  const runnable = (task: Task) =>
    hasRepo() &&
    !isTaskRunning(task.id) &&
    ["ready", "in_progress", "blocked", "failed", "needs_replan"].includes(task.status);

  const inGroup = (statuses: readonly string[]) => tasks().filter((t) => statuses.includes(t.status));

  return (
    <div class="page">
      <div class="page-inner">
        <div class="page-head">
          <h2>开发任务</h2>
          <span class="sub">
            {tasks().length} 个任务 · {tasks().filter((t) => t.status === "done").length} 已完成
          </span>
          <input
            class="search-input"
            placeholder="搜索任务…"
            value={search()}
            onInput={(event) => setSearch(event.currentTarget.value)}
          />
          <Show when={canEdit()}>
            <button class="btn primary" style={{ "margin-left": "auto" }} onClick={() => setNewOpen(true)}>
              + 新建任务
            </button>
          </Show>
        </div>

        <Show
          when={tasks().length}
          fallback={
            <div class="empty">
              还没有任务。让 Lead 在群里拆任务，或者直接 @Lead 说「拆一下任务」。
            </div>
          }
        >
          <div class="kanban">
            <For each={GROUPS}>
              {(group) => {
                const items = () => inGroup(group.statuses);
                return (
                  <div class="col">
                    <div class="col-head">
                      <span>{group.label}</span>
                      <span>{items().length}</span>
                    </div>
                    <For each={items()}>
                      {(task) => {
                        const role = roleOf(task);
                        return (
                          <div class="task-card">
                            <div class="task-title">{task.title}</div>
                            <div class="task-meta">
                              <Show when={role}>
                                <span
                                  class="badge"
                                  style={{
                                    "border-color": `${role!.color}44`,
                                    color: role!.color,
                                    background: `${role!.color}12`,
                                  }}
                                >
                                  {role!.displayName}
                                </span>
                              </Show>
                              <Show when={hasSpec(task)}>
                                <span class="badge ok">已绑定规格</span>
                              </Show>
                              <Show when={!hasSpec(task)}>
                                <span class="badge warn">未绑定规格</span>
                              </Show>
                              <span style={{ color: PRIORITY_COLOR[task.priority] ?? "#64748b" }}>
                                ● {task.priority}
                              </span>
                              <span>{task.status}</span>
                            </div>
                            <Show when={task.description}>
                              <div class="task-desc">{task.description}</div>
                            </Show>
                            <Show when={task.acceptance.length}>
                              <ul class="task-accept">
                                <For each={task.acceptance}>{(item) => <li>{item}</li>}</For>
                              </ul>
                            </Show>
                            <Show when={task.blockedReason}>
                              <div class="task-desc" style={{ color: "#fca5a5" }}>
                                阻塞：{task.blockedReason}
                              </div>
                            </Show>
                            <div style={{ "margin-top": "7px" }}>
                              <Show
                                when={canEditTask(task)}
                                fallback={<span class="badge">{task.status}</span>}
                              >
                                <select
                                  value={task.status}
                                  style={{
                                    width: "100%",
                                    background: "#10151a",
                                    border: "1px solid #232a32",
                                    "border-radius": "6px",
                                    padding: "3px 6px",
                                    "font-size": "11px",
                                    color: "#a2acb7",
                                  }}
                                  onChange={(event) => {
                                    const status = event.currentTarget.value;
                                    if (status !== task.status) {
                                      void updateTask(task.id, {
                                        status,
                                        expectedUpdatedAt: task.updatedAt,
                                      });
                                    }
                                    event.currentTarget.value = task.status;
                                  }}
                                >
                                  <For each={STATUS_OPTIONS}>
                                    {(status) => <option value={status}>{status}</option>}
                                  </For>
                                </select>
                              </Show>
                            </div>
                            <div style={{ display: "flex", gap: "6px", "margin-top": "7px", "flex-wrap": "wrap" }}>
                              <Show when={canEdit() && runnable(task)}>
                                <button
                                  class="btn primary"
                                  style={{ padding: "3px 9px", "font-size": "11px" }}
                                  disabled={workingTaskId() === task.id || isTaskRunning(task.id)}
                                  onClick={() => void startTaskWork(task.id)}
                                >
                                  {workingTaskId() === task.id
                                    ? "启动中…"
                                    : isTaskRunning(task.id)
                                      ? "运行中…"
                                      : task.status === "failed" || task.status === "blocked"
                                        ? "重试"
                                        : task.status === "in_progress"
                                          ? "重新开始"
                                          : "开始工作"}
                                </button>
                              </Show>
                              <Show when={diffId(task) || task.evidence?.["workspaceId"]}>
                                <button
                                  class="btn"
                                  style={{ padding: "3px 9px", "font-size": "11px" }}
                                  onClick={() => openTaskCode(task)}
                                >
                                  查看变更
                                </button>
                              </Show>
                              <Show when={mergeable(task)}>
                                <button
                                  class="btn primary"
                                  style={{ padding: "3px 9px", "font-size": "11px" }}
                                  onClick={() => setPendingMerge(task)}
                                >
                                  验收合并
                                </button>
                                <button
                                  class="btn"
                                  style={{ padding: "3px 9px", "font-size": "11px" }}
                                  onClick={() => {
                                    if (window.confirm("推送分支并尝试创建 GitHub PR？")) {
                                      void openTaskPullRequest(task);
                                    }
                                  }}
                                >
                                  推送 PR
                                </button>
                              </Show>
                              <Show
                                when={
                                  canEdit() && ["failed", "blocked"].includes(task.status)
                                }
                              >
                                <button
                                  class="btn"
                                  style={{ padding: "3px 9px", "font-size": "11px" }}
                                  onClick={() => {
                                    setTitle(`缺陷：${task.title}`);
                                    setDesc(
                                      `由任务「${task.title}」转来的缺陷。\n原因：${
                                        task.blockedReason ?? "任务未通过验证"
                                      }\n\n请定位根因、修复问题并补充回归测试。`,
                                    );
                                    setRole(task.roleKey ?? "backend");
                                    setAcceptance(
                                      task.acceptance.length
                                        ? task.acceptance.join("\n")
                                        : "修复失败用例并补充回归测试\nnpm test 全部通过",
                                    );
                                    setNewOpen(true);
                                  }}
                                >
                                  转缺陷
                                </button>
                              </Show>
                              <Show when={canEditTask(task)}>
                                <button
                                  class="btn"
                                  style={{ padding: "3px 9px", "font-size": "11px" }}
                                  onClick={async () => {
                                    setPendingDeps(task);
                                    setDepLoading(true);
                                    setDepIds(await loadTaskDependencies(task.id));
                                    setDepLoading(false);
                                  }}
                                >
                                  依赖
                                </button>
                                <button
                                  class="btn"
                                  style={{ padding: "3px 9px", "font-size": "11px" }}
                                  onClick={() => {
                                    setEditTitle(task.title);
                                    setEditDesc(task.description);
                                    setEditRole(task.roleKey ?? "");
                                    setEditPriority(task.priority);
                                    setEditAcceptance(task.acceptance.join("\n"));
                                    setEditingTask(task);
                                  }}
                                >
                                  编辑
                                </button>
                                <button
                                  class="btn danger"
                                  style={{ padding: "3px 9px", "font-size": "11px" }}
                                  disabled={workingTaskId() === task.id}
                                  onClick={() => setPendingDelete(task)}
                                >
                                  删除
                                </button>
                              </Show>
                              <Show when={!hasRepo()}>
                                <span class="badge warn">{demoMode() ? "演示模式" : "未配置仓库"}</span>
                              </Show>
                            </div>
                          </div>
                        );
                      }}
                    </For>
                  </div>
                );
              }}
            </For>
          </div>
        </Show>
      </div>

      <Show when={pendingDeps()}>
        {(task) => (
          <div class="modal-scrim" onClick={() => setPendingDeps(null)}>
            <div class="modal" onClick={(event) => event.stopPropagation()}>
              <h3>任务依赖</h3>
              <p>
                依赖任务完成或取消后，「{task().title}」才能开始工作。依赖不能形成环。
              </p>
              <Show when={depLoading()} fallback={
                <div class="dep-list">
                  <For each={allTasks().filter((candidate) => candidate.id !== task().id)}>
                    {(candidate) => (
                      <label class="dep-item">
                        <input
                          type="checkbox"
                          checked={depIds().includes(candidate.id)}
                          onChange={() =>
                            setDepIds((current) =>
                              current.includes(candidate.id)
                                ? current.filter((id) => id !== candidate.id)
                                : [...current, candidate.id],
                            )
                          }
                        />
                        <span class="dep-title">{candidate.title}</span>
                        <span class="badge">{candidate.status}</span>
                      </label>
                    )}
                  </For>
                  <Show when={allTasks().length <= 1}>
                    <div class="members-empty">还没有其他任务可以依赖。</div>
                  </Show>
                </div>
              }>
                <div class="members-empty">加载依赖…</div>
              </Show>
              <div class="modal-actions">
                <button class="btn" onClick={() => setPendingDeps(null)}>
                  取消
                </button>
                <button
                  class="btn primary"
                  disabled={depLoading() || savingDeps()}
                  onClick={async () => {
                    setSavingDeps(true);
                    const ok = await saveTaskDependencies(task().id, depIds());
                    setSavingDeps(false);
                    if (ok) setPendingDeps(null);
                  }}
                >
                  {savingDeps() ? "保存中…" : "保存依赖"}
                </button>
              </div>
            </div>
          </div>
        )}
      </Show>

      <Show when={pendingMerge()}>
        {(task) => (
          <div class="modal-scrim" onClick={() => setPendingMerge(null)}>
            <div class="modal" onClick={(event) => event.stopPropagation()}>
              <h3>验收并合并</h3>
              <p>
                将「{task().title}」的代码提交并合并到{" "}
                <strong>{snapshot()?.project.defaultBranch || "main"}</strong>。合并后会写入审计，
                任务状态变为已完成。
              </p>
              <div class="gate-note">
                只会合并已经通过规格核对的任务；如果基分支有未提交改动或合并冲突，会中止并保留工作区。
              </div>
              <div class="modal-actions">
                <button class="btn" onClick={() => setPendingMerge(null)}>
                  取消
                </button>
                <button
                  class="btn primary"
                  disabled={merging()}
                  onClick={async () => {
                    setMerging(true);
                    const ok = await mergeTaskWorkspace(task());
                    setMerging(false);
                    if (ok) setPendingMerge(null);
                  }}
                >
                  {merging() ? "合并中…" : "确认合并"}
                </button>
              </div>
            </div>
          </div>
        )}
      </Show>

      <Show when={editingTask()}>
        {(task) => (
          <div class="modal-scrim" onClick={() => setEditingTask(null)}>
            <div class="modal" onClick={(event) => event.stopPropagation()}>
              <h3>编辑任务</h3>
              <p>修改标题、描述、负责人、优先级和验收标准。已绑定的规格版本不会变化。</p>
              <div class="field">
                <label>标题</label>
                <input
                  autofocus
                  value={editTitle()}
                  onInput={(event) => setEditTitle(event.currentTarget.value)}
                />
              </div>
              <div class="field">
                <label>描述</label>
                <textarea
                  rows={3}
                  value={editDesc()}
                  onInput={(event) => setEditDesc(event.currentTarget.value)}
                />
              </div>
              <div class="field">
                <label>负责人</label>
                <select
                  value={editRole()}
                  onChange={(event) => setEditRole(event.currentTarget.value)}
                  style={{
                    width: "100%",
                    background: "#14181d",
                    border: "1px solid #232a32",
                    "border-radius": "8px",
                    padding: "7px 9px",
                  }}
                >
                  <option value="">未指定</option>
                  <For each={snapshot()?.roles ?? []}>
                    {(item) => <option value={item.key}>{item.displayName}</option>}
                  </For>
                </select>
              </div>
              <div class="field">
                <label>优先级</label>
                <select
                  value={editPriority()}
                  onChange={(event) => setEditPriority(event.currentTarget.value)}
                  style={{
                    width: "100%",
                    background: "#14181d",
                    border: "1px solid #232a32",
                    "border-radius": "8px",
                    padding: "7px 9px",
                  }}
                >
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                  <option value="critical">critical</option>
                </select>
              </div>
              <div class="field">
                <label>验收标准（一行一条）</label>
                <textarea
                  rows={3}
                  value={editAcceptance()}
                  onInput={(event) => setEditAcceptance(event.currentTarget.value)}
                />
              </div>
              <div class="modal-actions">
                <button class="btn" onClick={() => setEditingTask(null)}>
                  取消
                </button>
                <button
                  class="btn primary"
                  disabled={!editTitle().trim() || savingEdit()}
                  onClick={async () => {
                    setSavingEdit(true);
                    const ok = await updateTask(task().id, {
                      title: editTitle().trim(),
                      description: editDesc(),
                      roleKey: editRole() || null,
                      priority: editPriority(),
                      acceptance: editAcceptance()
                        .split("\n")
                        .map((line) => line.trim())
                        .filter(Boolean),
                      expectedUpdatedAt: task().updatedAt,
                    });
                    setSavingEdit(false);
                    if (ok) setEditingTask(null);
                  }}
                >
                  {savingEdit() ? "保存中…" : "保存"}
                </button>
              </div>
            </div>
          </div>
        )}
      </Show>

      <Show when={pendingDelete()}>
        {(task) => (
          <div class="modal-scrim" onClick={() => setPendingDelete(null)}>
            <div class="modal" onClick={(event) => event.stopPropagation()}>
              <h3>删除任务</h3>
              <p>
                删除「{task().title}」？该任务绑定的代码工作区会被清理；聊天记录和已生成的产物会保留。
              </p>
              <div class="modal-actions">
                <button class="btn" onClick={() => setPendingDelete(null)}>
                  取消
                </button>
                <button
                  class="btn danger"
                  disabled={deleting() || isTaskRunning(task().id)}
                  onClick={async () => {
                    if (isTaskRunning(task().id)) return;
                    setDeleting(true);
                    const ok = await deleteTask(task().id);
                    setDeleting(false);
                    if (ok) setPendingDelete(null);
                  }}
                >
                  {deleting() ? "删除中…" : "删除任务"}
                </button>
              </div>
            </div>
          </div>
        )}
      </Show>

      <Show when={newOpen()}>
        <div class="modal-scrim" onClick={() => setNewOpen(false)}>
          <div class="modal" onClick={(event) => event.stopPropagation()}>
            <h3>新建任务</h3>
            <p>手工建一个任务，直接交给某个员工执行。验收标准一行一条。</p>
            <div class="field">
              <label>标题</label>
              <input
                autofocus
                placeholder="例如：给 NoteStore 增加标签筛选和全文搜索"
                value={title()}
                onInput={(event) => setTitle(event.currentTarget.value)}
              />
            </div>
            <div class="field">
              <label>描述</label>
              <textarea
                rows={3}
                placeholder="现状、目标、相关文件"
                value={desc()}
                onInput={(event) => setDesc(event.currentTarget.value)}
              />
            </div>
            <div class="field">
              <label>负责人</label>
              <select
                value={role()}
                onChange={(event) => setRole(event.currentTarget.value)}
                style={{
                  width: "100%",
                  background: "#14181d",
                  border: "1px solid #232a32",
                  "border-radius": "8px",
                  padding: "7px 9px",
                }}
              >
                <For each={snapshot()?.roles ?? []}>
                  {(item) => <option value={item.key}>{item.displayName}</option>}
                </For>
              </select>
            </div>
            <div class="field">
              <label>验收标准（一行一条）</label>
              <textarea
                rows={3}
                placeholder={"标签筛选大小写不敏感\nnpm test 全部通过"}
                value={acceptance()}
                onInput={(event) => setAcceptance(event.currentTarget.value)}
              />
            </div>
            <div class="modal-actions">
              <button class="btn" onClick={() => setNewOpen(false)}>
                取消
              </button>
              <button
                class="btn primary"
                disabled={!title().trim()}
                onClick={async () => {
                  await createTask({
                    title: title().trim(),
                    description: desc().trim(),
                    roleKey: role(),
                    priority: "medium",
                    acceptance: acceptance()
                      .split("\n")
                      .map((line) => line.trim())
                      .filter(Boolean),
                  });
                  setTitle("");
                  setDesc("");
                  setAcceptance("");
                  setNewOpen(false);
                }}
              >
                创建任务
              </button>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
}
