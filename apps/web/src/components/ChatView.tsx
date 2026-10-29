import { For, Show, createEffect, createSignal, on, onCleanup, onMount } from "solid-js";
import type { Message, MessageAttachment, TurnSummary } from "@devteam/contracts";
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
import { api } from "../lib/api";
import { Avatar } from "./Avatar";
import { Markdown } from "../lib/markdown";

interface Chip {
  kind: string;
  label: string;
}

interface PendingFile {
  name: string;
  mime: string;
  size: number;
  data: string;
  preview: string | null;
}

function attachmentsOf(message: Message): MessageAttachment[] {
  const raw = message.metadata?.["attachments"];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is MessageAttachment =>
      Boolean(item) &&
      typeof item === "object" &&
      typeof (item as MessageAttachment).url === "string" &&
      typeof (item as MessageAttachment).id === "string",
  );
}

function bytesToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
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

function isPhaseTransition(message: Message): boolean {
  const actionTypes = message.metadata?.["actionTypes"];
  return (
    Array.isArray(actionTypes) &&
    (actionTypes.includes("request_phase") || actionTypes.includes("set_phase"))
  );
}

function messageBadge(message: Message): string | null {
  if (message.type === "discussion") return null;
  if (isPhaseTransition(message)) return "内部阶段推进";
  if (message.type === "question") return "问题";
  if (message.type === "task_handoff") return "任务交接";
  if (message.type === "decision") return "决策";
  if (message.type === "artifact") return "产物";
  if (message.type === "blocker") return "阻塞";
  return message.type;
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
  let fileInput: HTMLInputElement | undefined;
  const projectId = () => snapshot()?.project.id ?? "";
  const [value, setValue] = createSignal(savedDrafts.get(projectId()) ?? "");
  const [pendingFiles, setPendingFiles] = createSignal<PendingFile[]>([]);
  const [uploading, setUploading] = createSignal(false);
  const [mentionOpen, setMentionOpen] = createSignal(false);
  const [pickerOpen, setPickerOpen] = createSignal(false);

  createEffect(on(projectId, (id, previous) => {
    if (!previous || previous === id) return;
    savedDrafts.set(previous, value());
    setValue(savedDrafts.get(id) ?? "");
    for (const file of pendingFiles()) {
      if (file.preview) URL.revokeObjectURL(file.preview);
    }
    setPendingFiles([]);
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

  const displayMessages = () => {
    const all = messages();
    // Repeated "no ready work" notices are diagnostic, not conversation. Keep
    // only the latest one so a stuck queue does not fill the whole room.
    const lastGate = [...all].reverse().find((message) => message.metadata?.["kind"] === "gate_waiting");
    return all.filter(
      (message) =>
        message.metadata?.["kind"] !== "ops_heartbeat" &&
        (message.metadata?.["kind"] !== "gate_waiting" || message.id === lastGate?.id),
    );
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

  async function addFiles(files: FileList | File[]): Promise<void> {
    const incoming = Array.from(files);
    if (!incoming.length) return;
    const room = 8 - pendingFiles().length;
    if (room <= 0) {
      toast("一次最多上传 8 个附件。");
      return;
    }
    const selected = incoming.slice(0, room);
    const next: PendingFile[] = [];
    for (const file of selected) {
      if (file.size > 20 * 1024 * 1024) {
        toast(`${file.name} 超过 20 MB，已跳过。`);
        continue;
      }
      const mime = file.type || "application/octet-stream";
      next.push({
        name: file.name || "attachment",
        mime,
        size: file.size,
        data: bytesToBase64(await file.arrayBuffer()),
        preview: mime.startsWith("image/") ? URL.createObjectURL(file) : null,
      });
    }
    if (incoming.length > selected.length) toast("一次最多上传 8 个附件。");
    if (next.length) setPendingFiles([...pendingFiles(), ...next]);
  }

  function removeFile(index: number): void {
    const file = pendingFiles()[index];
    if (file?.preview) URL.revokeObjectURL(file.preview);
    setPendingFiles(pendingFiles().filter((_, i) => i !== index));
  }

  async function submit() {
    const text = value().trim();
    const files = pendingFiles();
    if ((!text && !files.length) || sending() || uploading()) return;
    setUploading(true);
    const ids: string[] = [];
    try {
      for (const file of files) {
        const uploaded = await api.uploadAttachment(projectId(), {
          name: file.name,
          mime: file.mime,
          data: file.data,
        });
        ids.push(uploaded.id);
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : "附件上传失败");
      setUploading(false);
      return;
    }
    setUploading(false);
    const mentions = [...text.matchAll(/@([A-Za-z\u4e00-\u9fa5]+)/g)].map((m) => m[1]!);
    setValue("");
    savedDrafts.delete(projectId());
    if (textarea) textarea.style.height = "42px";
    setMentionOpen(false);
    setPickerOpen(false);
    for (const file of files) {
      if (file.preview) URL.revokeObjectURL(file.preview);
    }
    setPendingFiles([]);
    void sendMessage(text || "请查看附件", mentions, ids);
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

          <For each={displayMessages()}>
            {(message) => {
              if (message.senderType === "system") {
                const clientConfirmation = message.metadata?.["kind"] === "client_confirmation";
                return (
                  <div class={`system-line ${clientConfirmation ? "client-confirmation" : ""}`}>
                    {message.content}
                  </div>
                );
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
                      <Show when={messageBadge(message)}>
                        <span class="badge">{messageBadge(message)}</span>
                      </Show>
                      <span class="msg-time">{timeOf(message.createdAt)}</span>
                    </div>
                    <Markdown content={message.content} />
                    <Show when={attachmentsOf(message).length}>
                      <div class="msg-attachments">
                        <For each={attachmentsOf(message)}>
                          {(attachment) => (
                            <a
                              class={`msg-attachment ${attachment.mime.startsWith("image/") ? "image" : "file"}`}
                              href={attachment.url}
                              target="_blank"
                              rel="noreferrer"
                              title={`${attachment.name} · ${Math.round(attachment.size / 1024)} KB`}
                            >
                              <Show
                                when={attachment.mime.startsWith("image/")}
                                fallback={
                                  <span class="msg-file">
                                    <span class="msg-file-icon">▤</span>
                                    <span>{attachment.name}</span>
                                    <small>
                                      {Math.max(1, Math.round(attachment.size / 1024))} KB
                                      {attachment.archive
                                        ? ` · 已解压 ${attachment.entries ?? 0} 个文件`
                                        : ""}
                                    </small>
                                  </span>
                                }
                              >
                                <img src={attachment.url} alt={attachment.name} />
                              </Show>
                            </a>
                          )}
                        </For>
                      </div>
                    </Show>
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
          <Show when={pendingFiles().length}>
            <div class="composer-attachments">
              <For each={pendingFiles()}>
                {(file, index) => (
                  <div class="composer-attachment">
                    <Show
                      when={file.preview}
                      fallback={
                        <span class="composer-file" title={file.name}>
                          <span>▤</span>
                          <small>{file.name}</small>
                        </span>
                      }
                    >
                      <img src={file.preview!} alt={file.name} />
                    </Show>
                    <button
                      type="button"
                      title="移除附件"
                      onClick={() => removeFile(index())}
                    >
                      ×
                    </button>
                  </div>
                )}
              </For>
            </div>
          </Show>
          <input
            ref={fileInput}
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={(event) => {
              const files = event.currentTarget.files;
              if (files) void addFiles(files);
              event.currentTarget.value = "";
            }}
          />
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
            onPaste={(event) => {
              const files = Array.from(event.clipboardData?.files ?? []).filter((file) =>
                file.type.startsWith("image/"),
              );
              if (files.length) {
                event.preventDefault();
                void addFiles(files);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
              if (event.key === "Escape") setMentionOpen(false);
            }}
          />
          <div class="composer-row">
            <button
              class="btn"
              style={{ padding: "3px 9px", "font-size": "11px" }}
              disabled={sending() || uploading()}
              title="上传图片或文件（也可以直接粘贴截图）"
              onClick={() => fileInput?.click()}
            >
              附件
            </button>
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
              disabled={sending() || uploading() || (!value().trim() && !pendingFiles().length)}
              onClick={() => void submit()}
            >
              {uploading() ? "上传中…" : sending() ? "发送中…" : "发送"}
            </button>
          </div>
        </div>
      </div>
      </Show>
    </div>
  );
}
