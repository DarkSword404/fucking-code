import { For, Show, onMount } from "solid-js";
import { runs, switchView } from "../lib/store";

const STATUS_CLASS: Record<string, string> = {
  succeeded: "ok",
  running: "warn",
  starting: "warn",
  queued: "",
  failed: "bad",
  cancelled: "",
  timed_out: "bad",
};

export function ActivityView() {
  onMount(() => switchView("activity"));

  return (
    <div class="page">
      <div class="page-inner">
        <div class="page-head">
          <h2>运行活动</h2>
          <span class="sub">每一次 Agent 运行都有状态、模型和耗时</span>
        </div>

        <Show
          when={runs().length}
          fallback={<div class="empty">还没有运行记录。在聊天室发一条消息就会启动团队。</div>}
        >
          <div style={{ border: "1px solid #232a32", "border-radius": "10px", overflow: "hidden" }}>
            <For each={runs()}>
              {(run) => (
                <div class="run" style={{ padding: "10px 12px" }}>
                  <div class="run-head">
                    <span class={`badge ${STATUS_CLASS[run.status] ?? ""}`}>{run.status}</span>
                    <span style={{ "font-weight": 600 }}>{run.roleName ?? run.roleKey ?? "Agent"}</span>
                    <span class="run-meta" style={{ "margin-left": "auto" }}>
                      {run.modelProvider}/{run.modelId ?? "default"}
                    </span>
                  </div>
                  <div class="run-meta">
                    {run.startedAt ? new Date(run.startedAt).toLocaleString("zh-CN") : "—"}
                    {run.endedAt && run.startedAt
                      ? ` · ${Math.max(
                          0,
                          Math.round(
                            (new Date(run.endedAt).getTime() - new Date(run.startedAt).getTime()) / 1000,
                          ),
                        )}s`
                      : ""}
                    {run.triggerMessageId ? ` · trigger ${run.triggerMessageId.slice(0, 8)}` : ""}
                  </div>
                  <Show when={run.error}>
                    <div class="run-meta" style={{ color: "#fca5a5" }}>
                      {run.error}
                    </div>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
}
