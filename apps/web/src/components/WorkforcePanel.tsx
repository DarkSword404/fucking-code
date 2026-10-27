import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { activity, roomReading, snapshot, thinking } from "../lib/store";

function elapsed(start: string | null | undefined, now: number): string {
  if (!start) return "";
  const ms = Math.max(0, now - new Date(start).getTime());
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

export function WorkforcePanel() {
  const [now, setNow] = createSignal(Date.now());
  onMount(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => window.clearInterval(timer));
  });

  const roles = () => snapshot()?.roles ?? [];
  const activeRuns = () =>
    (snapshot()?.runs ?? []).filter((run) => run.status === "running");
  const runFor = (roleKey: string) =>
    activeRuns().find(
      (run) =>
        run.roleKey === roleKey ||
        run.metadata?.["roleKey"] === roleKey ||
        (run.metadata?.["roleKey"] === undefined &&
          run.roleName === roles().find((r) => r.key === roleKey)?.displayName),
    );
  const taskFor = (taskId: unknown) =>
    typeof taskId === "string"
      ? snapshot()?.tasks.find((task) => task.id === taskId)
      : undefined;
  const actionFor = (roleKey: string, displayName: string): { text: string; active: boolean; start?: string | null } => {
    const run = runFor(roleKey);
    if (run) {
      const kind = String(run.metadata?.["kind"] ?? "");
      const task = taskFor(run.metadata?.["taskId"]);
      if (kind === "code") {
        return {
          text: task ? `开发中：${task.title}` : "开发中：正在修改代码",
          active: true,
          start: run.startedAt,
        };
      }
      if (kind === "verify") {
        return {
          text: task ? `验证中：${task.title}` : "验证中：测试 / 规格核对",
          active: true,
          start: run.startedAt,
        };
      }
      const detail = activity()[roleKey];
      return {
        text: detail ? `讨论中：${detail}` : "讨论中：正在组织回复",
        active: true,
        start: run.startedAt,
      };
    }
    if (thinking().includes(displayName)) {
      return { text: roomReading() ? "阅读中：评估是否需要发言" : "准备回复", active: true };
    }
    const role = roles().find((r) => r.key === roleKey);
    return { text: role?.inRoom === false ? "未在房间" : "待命", active: false };
  };
  const activeCount = () => roles().filter((role) => actionFor(role.key, role.displayName).active).length;

  return (
    <Show when={snapshot()}>
      <section class="workforce">
        <div class="workforce-head">
          <span>团队进展</span>
          <span class="workforce-count">{activeCount()} 人在工作</span>
        </div>
        <div class="workforce-list">
          <For each={roles()}>
            {(role) => {
              const state = () => actionFor(role.key, role.displayName);
              return (
                <div class="workforce-row" classList={{ idle: !state().active }}>
                  <span class="workforce-dot" style={{ background: role.color }} />
                  <div class="workforce-main">
                    <div class="workforce-name">{role.displayName}</div>
                    <div class="workforce-action" title={state().text}>{state().text}</div>
                  </div>
                  <span class="workforce-time">
                    {state().active ? elapsed(state().start, now()) : "—"}
                  </span>
                </div>
              );
            }}
          </For>
        </div>
      </section>
    </Show>
  );
}
