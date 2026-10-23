import { For, Show, createSignal, onMount } from "solid-js";
import type { ProjectMember } from "@devteam/contracts";
import { api } from "../lib/api";
import { authUser, isCurrentProjectOwner, reloadProjects, toast } from "../lib/store";

const ROLE_LABEL: Record<ProjectMember["role"], string> = {
  owner: "Owner",
  member: "Member",
  viewer: "Viewer",
};

export function ProjectMembers(props: { projectId: string }) {
  const [members, setMembers] = createSignal<ProjectMember[]>([]);
  const [email, setEmail] = createSignal("");
  const [role, setRole] = createSignal<ProjectMember["role"]>("member");
  const [adding, setAdding] = createSignal(false);
  const [busyId, setBusyId] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(true);

  const owner = () => isCurrentProjectOwner();
  const isSelf = (member: ProjectMember) => authUser()?.id === member.userId;

  async function load() {
    try {
      const result = await api.projectMembers(props.projectId);
      setMembers(result.items);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  onMount(() => {
    void load();
  });

  async function add() {
    if (!email().trim()) return;
    setAdding(true);
    try {
      await api.addProjectMember(props.projectId, email().trim(), role());
      setEmail("");
      await load();
      await reloadProjects();
      toast("成员已添加。");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    } finally {
      setAdding(false);
    }
  }

  async function changeRole(member: ProjectMember, next: ProjectMember["role"]) {
    if (next === member.role) return;
    setBusyId(member.userId);
    try {
      await api.updateProjectMember(props.projectId, member.userId, next);
      await load();
      await reloadProjects();
      toast(`${member.displayName ?? member.email ?? "成员"} 已设为 ${ROLE_LABEL[next]}。`);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  async function remove(member: ProjectMember) {
    if (!window.confirm(`移除 ${member.displayName ?? member.email ?? "该成员"}？`)) return;
    setBusyId(member.userId);
    try {
      await api.removeProjectMember(props.projectId, member.userId);
      await load();
      await reloadProjects();
      toast("成员已移除。");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div class="members-section">
      <div class="members-head">
        <span class="panel-title" style={{ margin: "0" }}>
          项目成员
        </span>
        <span class="badge">{members().length}</span>
      </div>

      <Show when={loading()}>
        <div class="members-empty">加载成员…</div>
      </Show>

      <For each={members()}>
        {(member) => (
          <div class="member-row">
            <div class="member-avatar">
              {(member.displayName ?? member.email ?? "?").slice(0, 1).toUpperCase()}
            </div>
            <div class="member-info">
              <div class="member-name">{member.displayName ?? "未命名成员"}</div>
              <div class="member-email">{member.email ?? member.userId}</div>
            </div>
            <Show
              when={owner() && !isSelf(member)}
              fallback={<span class={`role-pill ${member.role}`}>{ROLE_LABEL[member.role]}</span>}
            >
              <select
                class="member-role"
                value={member.role}
                disabled={busyId() === member.userId}
                onChange={(event) =>
                  void changeRole(member, event.currentTarget.value as ProjectMember["role"])
                }
              >
                <option value="owner">Owner</option>
                <option value="member">Member</option>
                <option value="viewer">Viewer</option>
              </select>
              <button
                class="btn danger member-remove"
                disabled={busyId() === member.userId}
                onClick={() => void remove(member)}
              >
                移除
              </button>
            </Show>
          </div>
        )}
      </For>

      <Show when={owner()}>
        <div class="member-add">
          <input
            placeholder="成员邮箱（需先注册）"
            value={email()}
            onInput={(event) => setEmail(event.currentTarget.value)}
          />
          <select
            value={role()}
            onChange={(event) => setRole(event.currentTarget.value as ProjectMember["role"])}
          >
            <option value="member">Member</option>
            <option value="viewer">Viewer</option>
            <option value="owner">Owner</option>
          </select>
          <button class="btn" disabled={!email().trim() || adding()} onClick={() => void add()}>
            {adding() ? "添加中…" : "添加"}
          </button>
        </div>
        <div class="gate-note">
          Owner 可管理成员和删除项目；Member 可聊天、改任务、跑代码；Viewer 只读。
        </div>
      </Show>
    </div>
  );
}
