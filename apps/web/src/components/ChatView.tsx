import { For, Show, createEffect, createSignal, on, onCleanup, onMount } from "solid-js";
import type { Message, TurnSummary } from "@devteam/contracts";
import {
  activity,
  canEditCurrentProject,
  messages,
  openArtifact,
  openPreview,
  openRight,
  roomReading,
  sendMessage,
  sending,
  setTurnParticipants,
  snapshot,
  stopRun,
  switchView,
  thinking,
  toast,
  turnParticipants,
} from "../lib/store";
import { Avatar } from "./Avatar";
import { Markdown } from "../lib/markdown";

interface Chip {
  kind: string;
  label: string;
}

function timeOf(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function turnOf(message: Message): TurnSummary | undefined {
  const raw = message.metadata?.["turn"];
  return raw && typeof raw === "object" ? (raw as TurnSummary) : undefined;
}

function TurnSummaryLine(props: { turn: TurnSummary; waiting?: boolean }) {
  const passedTitle = () =>
    props.turn.passed.map((p) => `${p.name}：${p.reason}`).join("\n") || "无";
  return (
    <div class="turn-summary">
      <span class="turn-chip">{props.turn.received} 人收到</span>
      <span class="turn-chip ok">
        {props.turn.spoke.length
          ? `${props.turn.spoke.map((s) => s.name).join("、")} 发言`
          : "无人发言"}
      </span>
      <Show when={props.turn.passed.length}>
        <span class="turn-chip" title={passedTitle()}>
          {props.turn.passed.length} 人沉默 · 查看原因
        </span>
      </Show>
      <Show when={props.waiting}>
        <span class="turn-chip wait">等待你回答</span>
      </Show>
      <span class="turn-rounds">{props.turn.rounds} 轮</span>
    </div>
  );
}

let savedChatScroll: { projectId: string; top: number; stick: boolean } | null = null;
const savedDrafts = new Map<string, string>();

export function ChatView() {
  let scrollEl: HTMLDivElement | undefined;
  let activeProjectId = "";
  let stickToBottom = true;
  let textarea: HTMLTextAreaElement | undefined;
  const projectId = () => snapshot()?.project.id ?? "";
  const [value, setValue] = createSignal(savedDrafts.get(projectId()) ?? "");
  const [mentionOpen, setMentionOpen] = createSignal(false);
  const [pickerOpen, setPickerOpen] = createSignal(false);

  createEffect(on(projectId, (id, previous) => {
    if (!previous || previous === id) return;
    savedDrafts.set(previous, value());
    setValue(savedDrafts.get(id) ?? "");
  }));

  const roles = () => snapshot()?.roles ?? [];
  const roleOf = (message: Message) =>
    roles().find((r) => r.id === message.senderId || r.key === message.metadata?.["roleKey"]);

  const chipsOf = (message: Message): Chip[] => {
    const raw = message.metadata?.["chips"];
    return Array.isArray(raw) ? (raw as Chip[]) : [];
  };

  const query = () => {
    const match = value().match(/@([A-Za-z\u4e00-\u9fa5]*)$/);
    return match ? (match[1] ?? "").toLowerCase() : null;
  };
  const filteredRoles = () => {
    const q = query();
    if (q === null) return [];
    return roles().filter(
      (r) =>
        r.enabled &&
        (r.key.toLowerCase().includes(q) ||
          r.displayName.toLowerCase().includes(q) ||
          r.description.includes(q)),
    );
  };

  const effectiveParticipants = () =>
    turnParticipants() ?? roles().filter((r) => r.inRoom).map((r) => r.key);

  const selectedNames = () =>
    roles()
      .filter((r) => effectiveParticipants().includes(r.key))
      .map((r) => r.displayName)
      .join("、");

  function togglePicker() {
    if (!pickerOpen() && turnParticipants() === null) {
      setTurnParticipants(roles().filter((r) => r.inRoom).map((r) => r.key));
    }
    setMentionOpen(false);
    setPickerOpen(!pickerOpen());
  }

  function toggleParticipant(key: string) {
    const current = effectiveParticipants();
    const next = current.includes(key)
      ? current.filter((item) => item !== key)
      : [...current, key];
    if (!next.length) return;
    setTurnParticipants(next);
  }

  const lastUserMessageId = () => {
    const userMessages = messages().filter((message) => message.senderType === "user");
    return userMessages[userMessages.length - 1]?.id;
  };

  const waitingForUser = () => {
    const all = messages();
    const userMessages = all.filter((message) => message.senderType === "user");
    const last = userMessages[userMessages.length - 1];
    const turn = last ? turnOf(last) : undefined;
    if (!turn?.waitingForUser) return false;
    // A question only blocks the composer while it is still the latest agent
    // turn. Newer agent/system turns mean the team moved on (or the question
    // was an engineering detail that should have been handled internally).
    const lastAgent = all.filter((message) => message.senderType === "agent").at(-1);
    const lastTurnId = lastAgent?.metadata?.["turnId"];
    return !lastTurnId || lastTurnId === turn.turnId;
  };

  const suggestions = (): Array<{ label: string; run: () => void }> => {
    const snap = snapshot();
    if (!snap) return [];
    const phase = snap.project.phase;
    const prd = snap.artifacts.find((a) => a.kind === "prd");
    if (phase === "requirements" && !prd) {
      return [
        {
          label: "让 PM 先问清楚需求",
          run: () =>
            void sendMessage(
              "@PM 先别急着出方案，先问我 3 个最关键的问题，把目标用户、核心场景、范围和成功标准问清楚。",
            ),
        },
      ];
    }
    if (phase === "requirements" && prd && prd.status === "in_review") {
      return [{ label: "审查 PRD", run: () => void openArtifact(prd.id) }];
    }
    if (phase === "design") {
      return [
        {
          label: "让 Architect 出方案",
          run: () => void sendMessage("@Architect 基于已确认的 PRD 给出技术方案、接口契约和威胁模型。"),
        },
        {
          label: "让 Lead 拆任务",
          run: () => void sendMessage("@Lead 把方案拆成可执行任务，前后端并行，并安排 Security 做安全设计。"),
        },
      ];
    }
    if (phase === "coding") {
      return [{ label: "让 QA 准备测试计划", run: () => void sendMessage("@QA 先给出测试策略和关键用例，不要在编码阶段做最终验收。") }];
    }
    if (phase === "testing") {
      return [{ label: "生成测试与安全报告", run: () => void sendMessage("@QA 汇总测试结果，生成测试报告；@Security 完成安全测试并给出结论。") }];
    }
    if (phase === "deployment") {
      return [{ label: "启动项目预览", run: () => void openPreview() }];
    }
    return [];
  };

  function saveScroll(): void {
    if (!scrollEl || !activeProjectId) return;
    savedChatScroll = {
      projectId: activeProjectId,
      top: scrollEl.scrollTop,
      stick: stickToBottom,
    };
  }

  function onScroll(): void {
    if (!scrollEl) return;
    stickToBottom =
      scrollEl.scrollHeight - scrollEl.clientHeight - scrollEl.scrollTop < 40;
    saveScroll();
  }

  onMount(() => {
    activeProjectId = snapshot()?.project.id ?? "";
    const saved =
      savedChatScroll && savedChatScroll.projectId === activeProjectId
        ? savedChatScroll
        : null;
    stickToBottom = saved?.stick ?? true;
    const top = saved?.top ?? 0;
    queueMicrotask(() => {
      if (!scrollEl) return;
      scrollEl.scrollTop = stickToBottom ? scrollEl.scrollHeight : top;
    });
    scrollEl?.addEventListener("scroll", onScroll, { passive: true });
  });

  onCleanup(() => {
    saveScroll();
    scrollEl?.removeEventListener("scroll", onScroll);
  });

  createEffect(() => {
    const projectId = snapshot()?.project.id ?? "";
    if (projectId !== activeProjectId) {
      const initialized = Boolean(activeProjectId);
      activeProjectId = projectId;
      if (initialized) {
        stickToBottom = true;
        savedChatScroll = null;
        queueMicrotask(() => {
          if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
        });
      }
    }
    messages().length;
    thinking().length;
    if (stickToBottom) {
      queueMicrotask(() =>
        scrollEl?.scrollTo({ top: scrollEl.scrollHeight, behavior: "smooth" }),
      );
    }
  });

  function resize() {
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(180, textarea.scrollHeight)}px`;
  }

  function insertMention(key: string) {
    const next = value().replace(/@([A-Za-z\u4e00-\u9fa5]*)$/, `@${key} `);
    setValue(next);
    savedDrafts.set(projectId(), next);
    setMentionOpen(false);
    textarea?.focus();
  }

  function submit() {
    const content = value().trim();
    if (!content || sending()) return;
    const mentions = [...content.matchAll(/@([A-Za-z\u4e00-\u9fa5]+)/g)].map((m) => m[1]!);
    setValue("");
    savedDrafts.delete(projectId());
    if (textarea) textarea.style.height = "42px";
    setMentionOpen(false);
    setPickerOpen(false);
    void sendMessage(content, mentions);
  }

  function onChip(chip: Chip) {
    if (chip.kind === "task") switchView("tasks");
    else if (chip.kind === "artifact") switchView("artifacts");
    else if (chip.kind === "decision" || chip.kind === "approval") openRight("gate");
  }

  return (
    <div class="view">
      <div class="chat-scroll" ref={scrollEl}>
        <div class="chat-inner">
          <Show when={!messages().length}>
            <div class="empty" style={{ "margin-top": "40px" }}>
              你是甲方，先说说想解决的问题或想要的产品。乙方团队会先问清楚，再开始动手。
            </div>
          </Show>

          <For each={messages()}>
            {(message) => {
              if (message.senderType === "system") {
                return <div class="system-line">{message.content}</div>;
              }
              const role = roleOf(message);
              const isUser = message.senderType === "user";
              const color = isUser ? "#f5b544" : role?.color ?? "#7dd3fc";
              const chips = chipsOf(message);
              return (
                <div class="msg">
                  <Avatar name={message.senderName} color={color} />
                  <div>
                    <div class="msg-head">
                      <span class="msg-name" style={{ color: isUser ? "#cbd5e1" : color }}>
                        {message.senderName}
                      </span>
                      <Show when={role && !isUser}>
                        <span class="msg-role">
                          {role!.displayName} · {role!.key}
                        </span>
                      </Show>
                      <Show when={isUser}>
                        <span class="msg-role client">甲方 · 客户</span>
                      </Show>
                      <Show when={message.type !== "discussion"}>
                        <span class="badge">
                          {message.type === "question"
                            ? "待甲方回答"
                            : message.type === "task_handoff"
                              ? "任务交接"
                              : message.type}
                        </span>
                      </Show>
                      <span class="msg-time">{timeOf(message.createdAt)}</span>
                    </div>
                    <Markdown content={message.content} />
                    <Show when={chips.length}>
                      <div class="chips">
                        <For each={chips}>
                          {(chip) => (
                            <button class={`chip ${chip.kind}`} onClick={() => onChip(chip)}>
                              {chip.label}
                            </button>
                          )}
                        </For>
                      </div>
                    </Show>
                    <Show when={message.senderType === "user" && turnOf(message)}>
                      <TurnSummaryLine
                        turn={turnOf(message)!}
                        waiting={message.id === lastUserMessageId() && waitingForUser()}
                      />
                    </Show>
                  </div>
                </div>
              );
            }}
          </For>

          <Show when={thinking().length || roomReading()}>
            <div class="thinking">
              <div class="dots">
                <i />
                <i />
                <i />
              </div>
              {thinking().length
                ? thinking()
                    .map((name) => {
                      const role = snapshot()?.roles.find((r) => r.displayName === name);
                      const detail = role ? activity()[role.key] : "";
                      return detail ? `${name}：${detail}` : `${name} 正在回复…`;
                    })
                    .join("；")
                : "团队正在阅读…"}
            </div>
          </Show>
        </div>
      </div>

      <Show
        when={canEditCurrentProject()}
        fallback={
          <div class="composer-wrap">
            <div class="gate-note">只读成员：可以查看讨论，但不能发言或停止运行。</div>
          </div>
        }
      >
        <div class="composer-wrap">
        <Show when={waitingForUser()}>
          <div class="waiting-note">团队在等你回答上面的问题；回答后会继续下一轮。</div>
        </Show>
        <Show when={suggestions().length}>
          <div class="suggestions">
            <For each={suggestions()}>
              {(suggestion) => (
                <button class="suggestion" onClick={suggestion.run}>
                  {suggestion.label}
                </button>
              )}
            </For>
          </div>
        </Show>
        <Show when={turnParticipants() !== null}>
          <div class="turn-picker-summary">
            <span>本次：{selectedNames() || "未选择"}</span>
            <button onClick={() => setTurnParticipants(null)}>恢复房间默认</button>
          </div>
        </Show>
        <div class="composer" style={{ position: "relative" }}>
          <Show when={pickerOpen()}>
            <div class="participant-menu">
              <div class="participant-head">
                <span>本次只叫这些人</span>
                <button
                  onClick={() => {
                    setTurnParticipants(null);
                    setPickerOpen(false);
                  }}
                >
                  恢复默认
                </button>
              </div>
              <For each={roles().filter((r) => r.enabled)}>
                {(role) => (
                  <label class="participant-item">
                    <input
                      type="checkbox"
                      checked={effectiveParticipants().includes(role.key)}
                      onChange={() => toggleParticipant(role.key)}
                    />
                    <Avatar name={role.displayName} color={role.color} size={20} />
                    <span>{role.displayName}</span>
                    <Show when={!role.inRoom}>
                      <span class="badge" style={{ "margin-left": "auto", "font-size": "9.5px" }}>
                        不在房间
                      </span>
                    </Show>
                  </label>
                )}
              </For>
              <div class="participant-foot">
                <button class="btn" onClick={() => setPickerOpen(false)}>
                  完成
                </button>
              </div>
            </div>
          </Show>
          <Show when={mentionOpen() && filteredRoles().length}>
            <div class="mention-menu">
              <For each={filteredRoles()}>
                {(role) => (
                  <button class="mention-item" onClick={() => insertMention(role.key)}>
                    <Avatar name={role.displayName} color={role.color} size={22} />
                    <span>{role.displayName}</span>
                    <span class="mention-key">@{role.key}</span>
                  </button>
                )}
              </For>
            </div>
          </Show>
          <textarea
            ref={textarea}
            rows={1}
            placeholder="作为甲方描述需求或回答问题… 团队会先澄清，再动手"
            value={value()}
            onInput={(event) => {
              const next = event.currentTarget.value;
              setValue(next);
              savedDrafts.set(projectId(), next);
              const mentioning = /@([A-Za-z\u4e00-\u9fa5]*)$/.test(next);
              setMentionOpen(mentioning);
              if (mentioning) setPickerOpen(false);
              resize();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
              if (event.key === "Escape") setMentionOpen(false);
            }}
          />
          <div class="composer-row">
            <button
              class={`btn ${turnParticipants() !== null ? "primary" : ""}`}
              style={{ padding: "3px 9px", "font-size": "11px" }}
              onClick={togglePicker}
              title="选择本次参与讨论的 Agent"
            >
              参与 {effectiveParticipants().length} 人
            </button>
            <span class="composer-hint">你是甲方 · Enter 发送 · Shift+Enter 换行 · @ 点名</span>
            <Show when={thinking().length || roomReading()}>
              <button class="btn danger" onClick={() => void stopRun()}>
                停止
              </button>
            </Show>
            <button
              class="btn primary"
              disabled={sending() || !value().trim()}
              onClick={submit}
            >
              {sending() ? "发送中…" : "发送"}
            </button>
          </div>
        </div>
      </div>
      </Show>
    </div>
  );
}
