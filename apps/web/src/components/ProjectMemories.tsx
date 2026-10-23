import { For, Show, createSignal, onMount } from "solid-js";
import type { Memory } from "@devteam/contracts";
import { api } from "../lib/api";
import { canEditCurrentProject, toast } from "../lib/store";

const STATUS_LABEL: Record<Memory["status"], string> = {
  proposed: "待审核",
  accepted: "已接受",
  rejected: "已拒绝",
  superseded: "已替代",
};

const TYPE_OPTIONS = ["fact", "preference", "decision", "constraint", "convention"];

export function ProjectMemories(props: { projectId: string }) {
  const [items, setItems] = createSignal<Memory[]>([]);
  const [type, setType] = createSignal("fact");
  const [title, setTitle] = createSignal("");
  const [content, setContent] = createSignal("");
  const [adding, setAdding] = createSignal(false);
  const [busyId, setBusyId] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(true);

  async function load() {
    try {
      const result = await api.projectMemories(props.projectId);
      setItems(result.items);
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
    if (!title().trim() || !content().trim()) return;
    setAdding(true);
    try {
      await api.createMemory(props.projectId, {
        type: type(),
        title: title().trim(),
        content: content().trim(),
      });
      setTitle("");
      setContent("");
      await load();
      toast("记忆已创建，接受后会注入讨论和代码任务。");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    } finally {
      setAdding(false);
    }
  }

  async function setStatus(memory: Memory, status: Memory["status"]) {
    setBusyId(memory.id);
    try {
      await api.updateMemory(props.projectId, memory.id, { status });
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  async function remove(memory: Memory) {
    if (!window.confirm(`删除记忆「${memory.title}」？`)) return;
    setBusyId(memory.id);
    try {
      await api.deleteMemory(props.projectId, memory.id);
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  const editor = () => canEditCurrentProject();

  return (
    <div class="memories-section">
      <div class="members-head">
        <span class="panel-title" style={{ margin: "0" }}>
          项目记忆（长期记忆）
        </span>
        <span class="badge">{items().filter((item) => item.status === "accepted").length} 已接受</span>
      </div>

      <Show when={loading()}>
        <div class="members-empty">加载记忆…</div>
      </Show>

      <Show when={!loading() && !items().length}>
        <div class="members-empty">还没有记忆。把需要长期遵守的事实、约束或约定写下来。</div>
      </Show>

      <For each={items()}>
        {(memory) => (
          <div class="memory-row">
            <div class="memory-row-head">
              <span class={`memory-status ${memory.status}`}>{STATUS_LABEL[memory.status]}</span>
              <span class="memory-type">{memory.type}</span>
              <strong class="memory-title">{memory.title}</strong>
              <span class="memory-version">v{memory.version}</span>
            </div>
            <div class="memory-content">{memory.content}</div>
            <Show when={editor()}>
              <div class="memory-actions">
                <Show when={memory.status !== "accepted"}>
                  <button
                    class="btn"
                    disabled={busyId() === memory.id}
                    onClick={() => void setStatus(memory, "accepted")}
                  >
                    接受
                  </button>
                </Show>
                <Show when={memory.status === "accepted"}>
                  <button
                    class="btn"
                    disabled={busyId() === memory.id}
                    onClick={() => void setStatus(memory, "superseded")}
                  >
                    停用
                  </button>
                </Show>
                <Show when={memory.status === "proposed"}>
                  <button
                    class="btn danger"
                    disabled={busyId() === memory.id}
                    onClick={() => void setStatus(memory, "rejected")}
                  >
                    拒绝
                  </button>
                </Show>
                <button
                  class="btn danger"
                  disabled={busyId() === memory.id}
                  onClick={() => void remove(memory)}
                >
                  删除
                </button>
              </div>
            </Show>
          </div>
        )}
      </For>

      <Show when={editor()}>
        <div class="memory-add">
          <select value={type()} onChange={(event) => setType(event.currentTarget.value)}>
            <For each={TYPE_OPTIONS}>{(option) => <option value={option}>{option}</option>}</For>
          </select>
          <input
            placeholder="记忆标题"
            value={title()}
            onInput={(event) => setTitle(event.currentTarget.value)}
          />
          <input
            placeholder="记忆内容"
            value={content()}
            onInput={(event) => setContent(event.currentTarget.value)}
          />
          <button class="btn" disabled={!title().trim() || !content().trim() || adding()} onClick={() => void add()}>
            {adding() ? "添加中…" : "添加"}
          </button>
        </div>
        <div class="gate-note">
          接受后的记忆会进入群聊上下文和代码任务提示词；代码 Agent 不会自行改写记忆。
        </div>
      </Show>
    </div>
  );
}
