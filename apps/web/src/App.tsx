import { For, Match, Show, Switch, createSignal, onMount } from "solid-js";
import { ARTIFACT_LABELS, PHASE_LABELS } from "@devteam/contracts";
import {
  advancePhase,
  authChecked,
  authUser,
  bootstrap,
  canEditCurrentProject,
  closeArtifact,
  createOpen,
  createProject,
  decideArtifact,
  deleteProject,
  demoMode,
  error,
  gateError,
  leftCollapsed,
  leftOpen,
  leftWidth,
  loading,
  openDecisionInbox,
  pendingDecisionCount,
  projects,
  requestAdvance,
  resumeAutoDevelopment,
  rightOpen,
  rightWidth,
  saveProjectSettings,
  selectedArtifact,
  setCreateOpen,
  setGateError,
  setLeftCollapsed,
  setLeftOpen,
  setLeftWidth,
  setRightOpen,
  setRightWidth,
  setSettingsOpen,
  settingsOpen,
  snapshot,
  view,
} from "./lib/store";
import { Markdown } from "./lib/markdown";
import { ChatView } from "./components/ChatView";
import { TasksView } from "./components/TasksView";
import { ArtifactsView } from "./components/ArtifactsView";
import { ActivityView } from "./components/ActivityView";
import { RightPanel } from "./components/RightPanel";
import { Sidebar, CollapsedRail } from "./components/Sidebar";
import { PhaseBar } from "./components/PhaseBar";
import { AuthScreen } from "./components/AuthScreen";
import { AdminView } from "./components/AdminView";
import { CodeView } from "./components/CodeView";
import { ProjectMembers } from "./components/ProjectMembers";
import { ProjectMemories } from "./components/ProjectMemories";
import { DecisionInbox } from "./components/DecisionInbox";

const STATUS_CLASS: Record<string, string> = {
  accepted: "ok",
  in_review: "warn",
  rejected: "bad",
};

function Workspace() {
  const [forceNote, setForceNote] = createSignal("");
  const [newName, setNewName] = createSignal("");
  const [newDesc, setNewDesc] = createSignal("");
  const [newRepo, setNewRepo] = createSignal("");
  const [dragging, setDragging] = createSignal<"left" | "right" | null>(null);
  const [settingsName, setSettingsName] = createSignal("");
  const [settingsDesc, setSettingsDesc] = createSignal("");
  const [settingsRepo, setSettingsRepo] = createSignal("");
  const [settingsRepoUrl, setSettingsRepoUrl] = createSignal("");
  const [settingsBranch, setSettingsBranch] = createSignal("main");
  const [settingsStatus, setSettingsStatus] = createSignal<"active" | "archived">("active");
  const [settingsBudget, setSettingsBudget] = createSignal("0");
  const [settingsVersion, setSettingsVersion] = createSignal(0);
  const [settingsAutoStart, setSettingsAutoStart] = createSignal(true);
  const [settingsSaving, setSettingsSaving] = createSignal(false);
  const [deleteOpen, setDeleteOpen] = createSignal(false);
  const [deleteConfirm, setDeleteConfirm] = createSignal("");
  const [deleting, setDeleting] = createSignal(false);

  function openSettings() {
    const project = snap()?.project;
    if (!project) return;
    setSettingsName(project.name);
    setSettingsDesc(project.description);
    setSettingsRepo(project.repoPath ?? "");
    setSettingsRepoUrl(project.repoUrl ?? "");
    setSettingsBranch(project.defaultBranch);
    setSettingsStatus(project.status === "archived" ? "archived" : "active");
    setSettingsBudget(String((project.budgetCents ?? 0) / 100));
    setSettingsVersion(project.version);
    setSettingsAutoStart(project.autoStartTasks);
    setSettingsOpen(true);
  }

  async function submitSettings() {
    setSettingsSaving(true);
    const ok = await saveProjectSettings({
      name: settingsName().trim(),
      description: settingsDesc(),
      repoPath: settingsRepo().trim() || null,
      repoUrl: settingsRepoUrl().trim() || null,
      defaultBranch: settingsBranch().trim() || "main",
      status: settingsStatus(),
      budgetCents: Math.max(0, Math.round(Number(settingsBudget() || 0) * 100)),
      autoStartTasks: settingsAutoStart(),
      expectedVersion: settingsVersion(),
    });
    setSettingsSaving(false);
    if (ok) setSettingsOpen(false);
  }

  onMount(() => {
    const left = Number(localStorage.getItem("devteam.leftWidth") ?? 0);
    const right = Number(localStorage.getItem("devteam.rightWidth") ?? 0);
    if (left >= 180) setLeftWidth(left);
    if (right >= 260) setRightWidth(right);
    if (window.innerWidth <= 820) setLeftOpen(false);
    if (window.innerWidth <= 1200) setRightOpen(false);
  });

  function startResize(side: "left" | "right", event: PointerEvent) {
    event.preventDefault();
    setDragging(side);
    const startX = event.clientX;
    const startWidth = side === "left" ? leftWidth() : rightWidth();
    const move = (e: PointerEvent) => {
      const delta = side === "left" ? e.clientX - startX : startX - e.clientX;
      const next = Math.min(480, Math.max(side === "left" ? 180 : 260, startWidth + delta));
      if (side === "left") setLeftWidth(next);
      else setRightWidth(next);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDragging(null);
      localStorage.setItem(
        side === "left" ? "devteam.leftWidth" : "devteam.rightWidth",
        String(side === "left" ? leftWidth() : rightWidth()),
      );
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function toggleLeft() {
    if (window.innerWidth <= 820) setLeftOpen(!leftOpen());
    else setLeftCollapsed(!leftCollapsed());
  }

  const snap = () => snapshot();
  const pending = () => pendingDecisionCount(snap());
  const isAdminView = () => view() === "admin";
  const isOwner = () => {
    const id = snap()?.project.id;
    if (!id) return false;
    return projects().find((project) => project.id === id)?.membershipRole === "owner";
  };
  const shellClass = () =>
    [
      "shell",
      leftCollapsed() ? "left-collapsed" : "",
      !rightOpen() ? "right-collapsed" : "",
      leftOpen() ? "left-open" : "",
      rightOpen() ? "right-open" : "",
    ].join(" ");

  return (
    <div
      class={shellClass()}
      style={
        {
          "--left-w": `${leftWidth()}px`,
          "--right-w": `${rightWidth()}px`,
          cursor: dragging() ? "col-resize" : undefined,
        } as never
      }
    >
      <Show when={!leftCollapsed()} fallback={<CollapsedRail />}>
        <Sidebar />
      </Show>

      <div class="center">
        <header class="topbar">
          <button class="icon-btn" title="切换侧栏" onClick={toggleLeft}>
            ☰
          </button>
          <div class="top-title">
            {isAdminView() ? "平台管理" : snap()?.project.name ?? "Fucking Code"}
          </div>
          <Show when={snap() && !isAdminView()}>
            <span class="badge phase-badge">{PHASE_LABELS[snap()!.project.phase]}</span>
            <PhaseBar current={snap()!.project.phase} />
            <button class="icon-btn" title="项目设置" onClick={openSettings}>
              ⚙
            </button>
          </Show>
          <Show when={pending() && !isAdminView()}>
            <button class="btn" onClick={openDecisionInbox}>
              <span style={{ color: "#f5b544" }}>●</span> {pending()} 项待决策
            </button>
          </Show>
          <Show when={!isAdminView() && !pending() && canEditCurrentProject()}>
            <button
              class="btn"
              onClick={requestAdvance}
              title="负责人兜底：手动推进到下一阶段；正常流程由 AI 提议并经你确认"
            >
              手动推进 →
            </button>
          </Show>
          <button class="icon-btn" title="切换右侧面板" onClick={() => setRightOpen(!rightOpen())}>
            {rightOpen() ? "⟩" : "⟨"}
          </button>
        </header>

        <Show when={demoMode()}>
          <div class="demo-banner">
            演示模式：聊天、需求、方案和任务可用；代码执行已禁用，数据会定期清理。
          </div>
        </Show>

        <Show
          when={snap() || isAdminView()}
          fallback={
            <div class="page">
              <div class="page-inner">
                <div class="empty">
                  还没有项目。点击左侧「+」新建项目，或接受邀请加入。
                </div>
              </div>
            </div>
          }
        >
          <Switch>
            <Match when={view() === "chat"}>
              <ChatView />
            </Match>
            <Match when={view() === "tasks"}>
              <TasksView />
            </Match>
            <Match when={view() === "code"}>
              <CodeView />
            </Match>
            <Match when={view() === "artifacts"}>
              <ArtifactsView />
            </Match>
            <Match when={view() === "activity"}>
              <ActivityView />
            </Match>
            <Match when={view() === "admin"}>
              <AdminView />
            </Match>
          </Switch>
        </Show>
      </div>

      <Show when={rightOpen() && snap()}>
        <RightPanel />
      </Show>

      <Show when={!leftCollapsed()}>
        <div
          class="resizer"
          style={{ position: "absolute", top: "0", bottom: "0", left: `${leftWidth() - 3}px` }}
          onPointerDown={(event) => startResize("left", event)}
        />
      </Show>
      <Show when={rightOpen()}>
        <div
          class="resizer"
          style={{ position: "absolute", top: "0", bottom: "0", right: `${rightWidth() - 3}px` }}
          onPointerDown={(event) => startResize("right", event)}
        />
      </Show>

      {/* Artifact review drawer */}
      <Show when={selectedArtifact()}>
        {(artifact) => (
          <div class="scrim" onClick={closeArtifact}>
            <div class="drawer" onClick={(event) => event.stopPropagation()}>
              <div class="drawer-head">
                <div>
                  <div class="artifact-kind">
                    {ARTIFACT_LABELS[artifact().kind] ?? artifact().kind} · v{artifact().currentVersion}
                  </div>
                  <div class="drawer-title">{artifact().title}</div>
                </div>
                <span class={`badge ${STATUS_CLASS[artifact().status] ?? ""}`} style={{ "margin-left": "10px" }}>
                  {artifact().status}
                </span>
                <button class="icon-btn" style={{ "margin-left": "auto" }} onClick={closeArtifact}>
                  ✕
                </button>
              </div>
              <div class="drawer-body">
                <Markdown content={artifact().content} class="doc" />
                <Show when={artifact().versions.length > 1}>
                  <div class="panel-title" style={{ "margin-top": "24px" }}>
                    版本历史
                  </div>
                  <For each={artifact().versions}>
                    {(version) => (
                      <div class="run">
                        <div class="run-head">
                          <span class="badge">v{version.version}</span>
                          <span>{version.summary || "（无摘要）"}</span>
                        </div>
                        <div class="run-meta">
                          {new Date(version.createdAt).toLocaleString("zh-CN")} · {version.createdBy ?? "unknown"}
                        </div>
                      </div>
                    )}
                  </For>
                </Show>
              </div>
              <div class="drawer-foot">
                <span class="badge">
                  {artifact().versions.length} 个版本
                </span>
                <div style={{ "margin-left": "auto", display: "flex", gap: "8px" }}>
                  <Show when={canEditCurrentProject()}>
                    <button
                      class="btn danger"
                      onClick={() => void decideArtifact(artifact().id, "rejected")}
                    >
                      退回
                    </button>
                    <button
                      class="btn primary"
                      onClick={() => void decideArtifact(artifact().id, "accepted")}
                    >
                      接受
                    </button>
                  </Show>
                </div>
              </div>
            </div>
          </div>
        )}
      </Show>

      {/* Gate failure */}
      <Show when={gateError()}>
        <div class="modal-scrim" onClick={() => setGateError(null)}>
          <div class="modal" onClick={(event) => event.stopPropagation()}>
            <h3>阶段门禁未满足</h3>
            <p>这些条件还没完成。你可以先补齐，或者以负责人身份填写理由强制推进（会写入审计）。</p>
            <For each={gateError()}>
              {(req) => (
                <div class={`gate ${req.met ? "met" : ""}`}>
                  <span class="tick">{req.met ? "✓" : "○"}</span>
                  <span>{req.label}</span>
                </div>
              )}
            </For>
            <div class="field" style={{ "margin-top": "12px" }}>
              <label>强制推进理由</label>
              <textarea
                rows={3}
                placeholder="例如：演示需要，先跳过正式测试报告"
                value={forceNote()}
                onInput={(event) => setForceNote(event.currentTarget.value)}
              />
            </div>
            <div class="modal-actions">
              <button class="btn" onClick={() => setGateError(null)}>
                取消
              </button>
              <button
                class="btn danger"
                disabled={!forceNote().trim()}
                onClick={async () => {
                  const ok = await advancePhase(true, forceNote());
                  if (ok) {
                    setForceNote("");
                    setGateError(null);
                  }
                }}
              >
                仍然推进
              </button>
            </div>
          </div>
        </div>
      </Show>

      {/* Create project */}
      <Show when={createOpen()}>
        <div class="modal-scrim" onClick={() => setCreateOpen(false)}>
          <div class="modal" onClick={(event) => event.stopPropagation()}>
            <h3>新建项目</h3>
            <p>给团队一个目标。创建后会自动生成聊天室和默认团队。</p>
            <div class="field">
              <label>项目名称</label>
              <input
                autofocus
                placeholder="例如：内部工单系统"
                value={newName()}
                onInput={(event) => setNewName(event.currentTarget.value)}
              />
            </div>
            <div class="field">
              <label>一句话描述</label>
              <textarea
                rows={3}
                placeholder="要解决什么问题？给谁用？"
                value={newDesc()}
                onInput={(event) => setNewDesc(event.currentTarget.value)}
              />
            </div>
            <div class="field">
              <label>本地仓库路径（可选，用于让 Agent 真正改代码）</label>
              <input
                placeholder="/absolute/path/to/repo"
                value={newRepo()}
                onInput={(event) => setNewRepo(event.currentTarget.value)}
              />
            </div>
            <div class="modal-actions">
              <button class="btn" onClick={() => setCreateOpen(false)}>
                取消
              </button>
              <button
                class="btn primary"
                disabled={!newName().trim()}
                onClick={async () => {
                  await createProject(newName().trim(), newDesc().trim(), newRepo());
                  setNewName("");
                  setNewDesc("");
                  setNewRepo("");
                }}
              >
                创建
              </button>
            </div>
          </div>
        </div>
      </Show>

      {/* Project settings */}
      <Show when={settingsOpen()}>
        <div class="modal-scrim" onClick={() => setSettingsOpen(false)}>
          <div class="modal" onClick={(event) => event.stopPropagation()}>
            <h3>项目设置</h3>
            <p>修改项目名称、描述和代码仓库。仓库路径变更后，代码视图会重新加载。</p>
            <Show when={!canEditCurrentProject()}>
              <p class="settings-note">你是只读成员，不能修改项目设置。</p>
            </Show>
            <div class="field">
              <label>项目名称</label>
              <input
                value={settingsName()}
                onInput={(event) => setSettingsName(event.currentTarget.value)}
              />
            </div>
            <div class="field">
              <label>项目描述</label>
              <textarea
                rows={3}
                value={settingsDesc()}
                onInput={(event) => setSettingsDesc(event.currentTarget.value)}
              />
            </div>
            <div class="field">
              <label>本地仓库路径（Agent 的工作区来源）</label>
              <input
                placeholder="/absolute/path/to/repo"
                value={settingsRepo()}
                onInput={(event) => setSettingsRepo(event.currentTarget.value)}
              />
            </div>
            <div class="field">
              <label>远程仓库 URL（可选）</label>
              <input
                placeholder="https://github.com/org/repo"
                value={settingsRepoUrl()}
                onInput={(event) => setSettingsRepoUrl(event.currentTarget.value)}
              />
            </div>
            <div class="field">
              <label>默认分支</label>
              <input
                placeholder="main"
                value={settingsBranch()}
                onInput={(event) => setSettingsBranch(event.currentTarget.value)}
              />
            </div>
            <div class="field">
              <label style={{ display: "flex", "align-items": "center", gap: "8px" }}>
                <input
                  type="checkbox"
                  checked={settingsAutoStart()}
                  onChange={(event) => setSettingsAutoStart(event.currentTarget.checked)}
                  style={{ width: "auto" }}
                />
                进入开发实现后自动启动任务
              </label>
              <p class="settings-note" style={{ "margin-top": "6px" }}>
                自动启动只负责开发；代码仍需测试、规格核对和人工验收合并。
              </p>
            </div>
            <div class="field">
              <label>项目状态</label>
              <select
                value={settingsStatus()}
                onChange={(event) =>
                  setSettingsStatus(event.currentTarget.value as "active" | "archived")
                }
              >
                <option value="active">进行中</option>
                <option value="archived">已归档</option>
              </select>
            </div>
            <div class="field">
              <label>预算（元）</label>
              <input
                type="number"
                min="0"
                step="1"
                value={settingsBudget()}
                onInput={(event) => setSettingsBudget(event.currentTarget.value)}
              />
            </div>
            <Show when={snap()?.project.id}>
              {(projectId) => (
                <>
                  <ProjectMembers projectId={projectId()} />
                  <ProjectMemories projectId={projectId()} />
                </>
              )}
            </Show>
            <Show when={isOwner()}>
              <div class="settings-danger">
                <div>
                  <strong>删除项目</strong>
                  <p>删除项目、聊天、任务、产物和所有代码工作区。此操作不可恢复。</p>
                </div>
                <button
                  class="btn danger"
                  onClick={() => {
                    setSettingsOpen(false);
                    setDeleteConfirm("");
                    setDeleteOpen(true);
                  }}
                >
                  删除项目
                </button>
              </div>
            </Show>
            <div class="modal-actions">
              <button class="btn" onClick={() => setSettingsOpen(false)}>
                取消
              </button>
              <button
                class="btn primary"
                disabled={!canEditCurrentProject() || !settingsName().trim() || settingsSaving()}
                onClick={() => void submitSettings()}
              >
                {settingsSaving() ? "保存中…" : "保存"}
              </button>
            </div>
          </div>
        </div>
      </Show>

      <Show when={deleteOpen()}>
        <div class="modal-scrim" onClick={() => setDeleteOpen(false)}>
          <div class="modal" onClick={(event) => event.stopPropagation()}>
            <h3>删除项目</h3>
            <p>
              你正在删除 <strong>{snap()?.project.name}</strong>。项目数据、聊天记录、任务、产物和代码工作区都会被清理，且无法恢复。
            </p>
            <div class="field">
              <label>输入项目名称确认</label>
              <input
                autofocus
                placeholder={snap()?.project.name ?? ""}
                value={deleteConfirm()}
                onInput={(event) => setDeleteConfirm(event.currentTarget.value)}
              />
            </div>
            <div class="modal-actions">
              <button class="btn" onClick={() => setDeleteOpen(false)}>
                取消
              </button>
              <button
                class="btn danger"
                disabled={
                  deleting() ||
                  !deleteConfirm().trim() ||
                  deleteConfirm().trim() !== snap()?.project.name
                }
                onClick={async () => {
                  setDeleting(true);
                  const ok = await deleteProject();
                  setDeleting(false);
                  if (ok) setDeleteOpen(false);
                }}
              >
                {deleting() ? "删除中…" : "永久删除"}
              </button>
            </div>
          </div>
        </div>
      </Show>

      <DecisionInbox />

      <Show when={loading() && !snap()}>
        <div class="modal-scrim">
          <div style={{ color: "#a2acb7" }}>正在连接团队…</div>
        </div>
      </Show>
    </div>
  );
}

export function App() {
  onMount(() => {
    void bootstrap();
  });

  return (
    <>
      <Show when={authChecked()} fallback={<div class="auth-loading">正在加载…</div>}>
        <Show when={authUser()} fallback={<AuthScreen />}>
          <Workspace />
        </Show>
      </Show>
      <Show when={error()}>
        <div class="toast">{error()}</div>
      </Show>
    </>
  );
}
