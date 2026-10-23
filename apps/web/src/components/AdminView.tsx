import { For, Show, createSignal, onMount } from "solid-js";
import type { AdminInvite, AdminProject, AdminUser } from "../lib/api";
import {
  adminCreateInvite,
  adminDeleteProject,
  adminDeleteUser,
  adminInvites,
  adminLoading,
  adminProjects,
  adminResetPassword,
  adminRevokeInvite,
  adminStats,
  adminUpdateUser,
  adminUsers,
  authUser,
  loadAdmin,
  toast,
} from "../lib/store";

type Tab = "overview" | "users" | "projects" | "invites";

const TABS: Array<{ key: Tab; label: string }> = [
  { key: "overview", label: "概览" },
  { key: "users", label: "用户" },
  { key: "projects", label: "项目" },
  { key: "invites", label: "邀请码" },
];

function timeOf(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("zh-CN");
}

export function AdminView() {
  const [tab, setTab] = createSignal<Tab>("overview");
  const [label, setLabel] = createSignal("");
  const [maxUses, setMaxUses] = createSignal(1);
  const [days, setDays] = createSignal(7);

  onMount(() => {
    void loadAdmin();
  });

  const isSelf = (user: AdminUser) => user.id === authUser()?.id;

  async function resetPassword(user: AdminUser) {
    const password = window.prompt(`为 ${user.email} 设置新密码（至少 8 位）`);
    if (password) await adminResetPassword(user.id, password);
  }

  function removeUser(user: AdminUser) {
    if (window.confirm(`删除 ${user.email} 及其所有项目、聊天和产物？此操作不可恢复。`)) {
      void adminDeleteUser(user.id);
    }
  }

  function removeProject(project: AdminProject) {
    if (window.confirm(`删除项目「${project.name}」及其所有数据？此操作不可恢复。`)) {
      void adminDeleteProject(project.id);
    }
  }

  async function createInvite() {
    await adminCreateInvite({
      label: label().trim() || undefined,
      maxUses: Math.max(1, maxUses()),
      expiresInDays: Math.max(1, days()),
    });
    setLabel("");
  }

  function copy(code: string) {
    void navigator.clipboard
      .writeText(code)
      .then(() => toast("邀请码已复制"))
      .catch(() => toast(code));
  }

  return (
    <div class="page">
      <div class="page-inner">
        <div class="page-head">
          <h2>管理后台</h2>
          <span class="sub">用户、项目、邀请码</span>
          <button class="btn" style={{ "margin-left": "auto" }} onClick={() => void loadAdmin()}>
            刷新
          </button>
        </div>

        <div class="admin-tabs">
          <For each={TABS}>
            {(item) => (
              <button
                class={`admin-tab ${tab() === item.key ? "active" : ""}`}
                onClick={() => setTab(item.key)}
              >
                {item.label}
              </button>
            )}
          </For>
        </div>

        <Show when={adminLoading()}>
          <div class="empty">加载中…</div>
        </Show>

        <Show when={!adminLoading() && tab() === "overview"}>
          <div class="admin-stats">
            <div class="admin-stat">
              <div class="n">{adminStats()?.users ?? 0}</div>
              <div class="l">用户</div>
            </div>
            <div class="admin-stat">
              <div class="n">{adminStats()?.activeUsers ?? 0}</div>
              <div class="l">正常账号</div>
            </div>
            <div class="admin-stat">
              <div class="n">{adminStats()?.projects ?? 0}</div>
              <div class="l">项目</div>
            </div>
            <div class="admin-stat">
              <div class="n">{adminStats()?.messagesToday ?? 0}</div>
              <div class="l">今日消息</div>
            </div>
            <div class="admin-stat">
              <div class="n">{adminStats()?.runsToday ?? 0}</div>
              <div class="l">今日 Agent 运行</div>
            </div>
            <div class="admin-stat">
              <div class="n">{adminStats()?.activeInvites ?? 0}</div>
              <div class="l">可用邀请码</div>
            </div>
          </div>
          <div class="gate-note">
            只有管理员能进入这个页面。普通用户看不到入口，直接调用管理 API 也会被服务端拒绝。
          </div>
        </Show>

        <Show when={!adminLoading() && tab() === "users"}>
          <div class="admin-scroll">
            <table class="admin-table">
              <thead>
                <tr>
                  <th>用户</th>
                  <th>项目</th>
                  <th>消息</th>
                  <th>最近登录</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                <For each={adminUsers()}>
                  {(user) => (
                    <tr>
                      <td>
                        <div>
                          {user.displayName}{" "}
                          <Show when={user.isAdmin}>
                            <span class="badge">管理员</span>
                          </Show>
                        </div>
                        <div class="admin-muted">{user.email}</div>
                      </td>
                      <td>{user.projectCount}</td>
                      <td>{user.messageCount}</td>
                      <td>{timeOf(user.lastLoginAt)}</td>
                      <td>
                        <span class={`badge ${user.isActive ? "ok" : "bad"}`}>
                          {user.isActive ? "正常" : "已禁用"}
                        </span>
                      </td>
                      <td>
                        <div class="admin-actions">
                          <Show when={!isSelf(user)}>
                            <button
                              class="btn"
                              onClick={() =>
                                void adminUpdateUser(user.id, { isActive: !user.isActive })
                              }
                            >
                              {user.isActive ? "禁用" : "启用"}
                            </button>
                            <button
                              class="btn"
                              onClick={() =>
                                void adminUpdateUser(user.id, { isAdmin: !user.isAdmin })
                              }
                            >
                              {user.isAdmin ? "取消管理员" : "设为管理员"}
                            </button>
                          </Show>
                          <button class="btn" onClick={() => void resetPassword(user)}>
                            改密
                          </button>
                          <Show when={!isSelf(user)}>
                            <button class="btn danger" onClick={() => removeUser(user)}>
                              删除
                            </button>
                          </Show>
                        </div>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>

        <Show when={!adminLoading() && tab() === "projects"}>
          <div class="admin-scroll">
            <table class="admin-table">
              <thead>
                <tr>
                  <th>项目</th>
                  <th>所有者</th>
                  <th>阶段</th>
                  <th>任务 / 产物 / 消息</th>
                  <th>更新时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                <For each={adminProjects()}>
                  {(project) => (
                    <tr>
                      <td>
                        <div>{project.name}</div>
                        <div class="admin-muted">{project.id.slice(0, 8)}</div>
                      </td>
                      <td>
                        <div>{project.owner?.displayName ?? "—"}</div>
                        <div class="admin-muted">{project.owner?.email ?? ""}</div>
                      </td>
                      <td>{project.phase}</td>
                      <td>
                        {project.taskCount} / {project.artifactCount} / {project.messageCount}
                      </td>
                      <td>{timeOf(project.updatedAt)}</td>
                      <td>
                        <button class="btn danger" onClick={() => removeProject(project)}>
                          删除
                        </button>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>

        <Show when={!adminLoading() && tab() === "invites"}>
          <div class="admin-invite-form">
            <input
              placeholder="标签（可选，例如：朋友测试）"
              value={label()}
              onInput={(event) => setLabel(event.currentTarget.value)}
            />
            <label class="admin-inline">
              可用次数
              <input
                type="number"
                min={1}
                max={1000}
                value={maxUses()}
                onInput={(event) => setMaxUses(Number(event.currentTarget.value))}
              />
            </label>
            <label class="admin-inline">
              有效天数
              <input
                type="number"
                min={1}
                max={365}
                value={days()}
                onInput={(event) => setDays(Number(event.currentTarget.value))}
              />
            </label>
            <button class="btn primary" onClick={() => void createInvite()}>
              生成邀请码
            </button>
          </div>

          <div class="admin-scroll">
            <table class="admin-table">
              <thead>
                <tr>
                  <th>邀请码</th>
                  <th>标签</th>
                  <th>使用</th>
                  <th>过期</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                <For each={adminInvites()}>
                  {(invite: AdminInvite) => (
                    <tr>
                      <td>
                        <button class="admin-code" onClick={() => copy(invite.code)} title="点击复制">
                          {invite.code}
                        </button>
                      </td>
                      <td>{invite.label || "—"}</td>
                      <td>
                        {invite.uses} / {invite.maxUses}
                      </td>
                      <td>{timeOf(invite.expiresAt)}</td>
                      <td>
                        <span class={`badge ${invite.active ? "ok" : "bad"}`}>
                          {invite.active ? "可用" : "已停用"}
                        </span>
                      </td>
                      <td>
                        <button class="btn danger" onClick={() => void adminRevokeInvite(invite.id)}>
                          撤销
                        </button>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
          <div class="gate-note">
            邀请码列表只对管理员可见。普通用户注册时必须输入一个未过期、未用尽的邀请码。
            环境变量里的 <code>SIGNUP_INVITE_CODE</code> 仍然有效，适合作为长期兜底码。
          </div>
        </Show>
      </div>
    </div>
  );
}
