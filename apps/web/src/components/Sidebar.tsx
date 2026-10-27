import { For, Show, createSignal } from "solid-js";
import { WorkforcePanel } from "./WorkforcePanel";
import { PHASE_LABELS } from "@devteam/contracts";
import {
  authUser,
  changePassword,
  connected,
  currentId,
  leftCollapsed,
  loadProject,
  logout,
  projects,
  reloadProjects,
  setCreateOpen,
  setLeftCollapsed,
  setLeftOpen,
  snapshot,
  switchView,
  view,
} from "../lib/store";

const NAV = [
  { key: "chat", label: "团队聊天室", icon: "◈" },
  { key: "tasks", label: "开发任务", icon: "▤" },
  { key: "code", label: "代码 / 目录", icon: "⌘" },
  { key: "artifacts", label: "需求与产物", icon: "▧" },
  { key: "activity", label: "运行活动", icon: "◷" },
] as const;

export function Sidebar() {
  const [passwordOpen, setPasswordOpen] = createSignal(false);
  const [currentPassword, setCurrentPassword] = createSignal("");
  const [newPassword, setNewPassword] = createSignal("");
  const [savingPassword, setSavingPassword] = createSignal(false);
  const project = () => snapshot()?.project;
  const openTasks = () => snapshot()?.tasks.filter((t) => t.status !== "done" && t.status !== "cancelled").length ?? 0;
  const pendingApprovals = () => snapshot()?.approvals.filter((a) => a.status === "pending").length ?? 0;

  const countFor = (key: string) => {
    if (key === "tasks") return openTasks() || undefined;
    if (key === "artifacts") return snapshot()?.artifacts.length || undefined;
    if (key === "chat") return undefined;
    return undefined;
  };

  return (
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark">FC</div>
        <div>
          <div>Fucking Code</div>
          <div class="brand-sub">AI 研发团队</div>
        </div>
        <button
          class="icon-btn"
          style={{ "margin-left": "auto" }}
          title="收起侧栏"
          onClick={() => setLeftCollapsed(true)}
        >
          ⟨
        </button>
      </div>

      <div class="side-section">
        <span>项目</span>
        <div style={{ display: "flex", gap: "2px" }}>
          <button
            class="icon-btn"
            title="刷新项目列表"
            onClick={() => void reloadProjects()}
          >
            ⟳
          </button>
          <button class="icon-btn" title="新建项目" onClick={() => setCreateOpen(true)}>
            +
          </button>
        </div>
      </div>
      <div class="project-list">
        <For each={projects()}>
          {(item) => (
            <button
              class={`project-item ${item.id === currentId() ? "active" : ""}`}
              onClick={() => {
                void loadProject(item.id);
                setLeftOpen(false);
              }}
              title={item.description}
            >
              <span class="project-dot" style={{ background: item.id === currentId() ? "#7dd3fc" : "#3a4652" }} />
              <span class="project-name">{item.name}</span>
              <Show when={item.status === "archived"}>
                <span class="badge" style={{ "margin-left": "auto", "font-size": "9px" }}>
                  归档
                </span>
              </Show>
            </button>
          )}
        </For>
        <Show when={!projects().length}>
          <div class="empty" style={{ padding: "14px 8px" }}>
            还没有项目
          </div>
        </Show>
      </div>

      <div class="side-section" style={{ "margin-top": "8px" }}>
        <span>工作区</span>
      </div>
      <nav class="nav">
        <For each={NAV}>
          {(item) => (
            <button
              class={`nav-item ${view() === item.key ? "active" : ""}`}
              onClick={() => switchView(item.key)}
            >
              <span style={{ width: "14px", "text-align": "center", opacity: 0.8 }}>{item.icon}</span>
              {item.label}
              <Show when={countFor(item.key)}>
                <span class="count">{countFor(item.key)}</span>
              </Show>
            </button>
          )}
        </For>
      </nav>

      <Show when={authUser()?.isAdmin}>
        <div class="side-section" style={{ "margin-top": "8px" }}>
          <span>平台</span>
        </div>
        <button
          class={`nav-item ${view() === "admin" ? "active" : ""}`}
          onClick={() => switchView("admin")}
          style={{ "margin-left": "8px", "margin-right": "8px", width: "calc(100% - 16px)" }}
        >
          <span style={{ width: "14px", "text-align": "center", opacity: 0.8 }}>⚙</span>
          管理后台
        </button>
      </Show>

      <div style={{ padding: "8px 12px", "margin-top": "4px" }}>
        <Show when={project()}>
          <div class="badge" style={{ display: "inline-flex", gap: "6px", "align-items": "center" }}>
            <span style={{ color: "#7dd3fc" }}>●</span>
            {PHASE_LABELS[project()!.phase]}
          </div>
          <Show when={pendingApprovals() > 0}>
            <button
              class="badge warn"
              style={{ "margin-left": "6px", cursor: "pointer" }}
              onClick={() => {
                switchView("chat");
                setLeftOpen(false);
              }}
            >
              {pendingApprovals()} 项待审批
            </button>
          </Show>
        </Show>
      </div>

      <WorkforcePanel />

      <div class="sidebar-foot">
        <span class={`conn-dot ${connected() ? "on" : ""}`} />
        <span>{connected() ? "实时连接" : "重连中…"}</span>
        <span class="foot-user" title={authUser()?.email ?? ""}>
          {authUser()?.displayName ?? ""}
        </span>
        <button
          class="foot-logout"
          title="修改密码"
          onClick={() => {
            setCurrentPassword("");
            setNewPassword("");
            setPasswordOpen(true);
          }}
        >
          密码
        </button>
        <button class="foot-logout" title="退出登录" onClick={() => void logout()}>
          退出
        </button>
      </div>

      <Show when={passwordOpen()}>
        <div class="modal-scrim" onClick={() => setPasswordOpen(false)}>
          <div class="modal" onClick={(event) => event.stopPropagation()}>
            <h3>修改密码</h3>
            <p>修改成功后其他登录会话会退出，当前会话保持登录。</p>
            <div class="field">
              <label>当前密码</label>
              <input
                type="password"
                autofocus
                value={currentPassword()}
                onInput={(event) => setCurrentPassword(event.currentTarget.value)}
              />
            </div>
            <div class="field">
              <label>新密码（至少 8 位）</label>
              <input
                type="password"
                value={newPassword()}
                onInput={(event) => setNewPassword(event.currentTarget.value)}
              />
            </div>
            <div class="modal-actions">
              <button class="btn" onClick={() => setPasswordOpen(false)}>
                取消
              </button>
              <button
                class="btn primary"
                disabled={
                  !currentPassword() || newPassword().length < 8 || savingPassword()
                }
                onClick={async () => {
                  setSavingPassword(true);
                  const ok = await changePassword(currentPassword(), newPassword());
                  setSavingPassword(false);
                  if (ok) {
                    setCurrentPassword("");
                    setNewPassword("");
                    setPasswordOpen(false);
                  }
                }}
              >
                {savingPassword() ? "保存中…" : "更新密码"}
              </button>
            </div>
          </div>
        </div>
      </Show>
    </aside>
  );
}

export function CollapsedRail() {
  return (
    <aside class="sidebar">
      <div class="collapsed-rail">
        <button class="rail-btn" title="展开侧栏" onClick={() => setLeftCollapsed(false)}>
          ⟩
        </button>
        <div class="brand-mark" style={{ "margin": "6px 0" }}>
          DT
        </div>
        <For each={NAV}>
          {(item) => (
            <button
              class="rail-btn"
              title={item.label}
              onClick={() => switchView(item.key)}
              style={view() === item.key ? { color: "#7dd3fc", background: "#16222b" } : {}}
            >
              {item.icon}
            </button>
          )}
        </For>
      </div>
    </aside>
  );
}
