import { For, Show } from "solid-js";
import { ARTIFACT_LABELS, PHASE_LABELS } from "@devteam/contracts";
import {
  acceptPendingTechnicalArtifacts,
  canEditCurrentProject,
  decideApproval,
  decideArtifact,
  decideDecision,
  openArtifact,
  presence,
  rightTab,
  runs,
  setRightTab,
  snapshot,
  thinking,
  toggleRoleInRoom,
} from "../lib/store";
import { Avatar } from "./Avatar";

const STATUS_CLASS: Record<string, string> = {
  succeeded: "ok",
  running: "warn",
  starting: "warn",
  failed: "bad",
  timed_out: "bad",
};

export function RightPanel() {
  const snap = () => snapshot();
  const roles = () => snap()?.roles ?? [];
  const approvals = () => snap()?.approvals.filter((a) => a.status === "pending") ?? [];
  const decisions = () => snap()?.decisions.filter((d) => d.status === "proposed") ?? [];
  const requirements = () => snap()?.phaseRequirements ?? [];
  const inReview = () => snap()?.artifacts.filter((a) => a.status === "in_review") ?? [];

  return (
    <aside class="right">
      <div class="right-tabs">
        <button class={`right-tab ${rightTab() === "team" ? "active" : ""}`} onClick={() => setRightTab("team")}>
          团队
        </button>
        <button class={`right-tab ${rightTab() === "gate" ? "active" : ""}`} onClick={() => setRightTab("gate")}>
          门禁 {approvals().length ? `· ${approvals().length}` : ""}
        </button>
        <button class={`right-tab ${rightTab() === "runs" ? "active" : ""}`} onClick={() => setRightTab("runs")}>
          运行
        </button>
      </div>

      <div class="right-body">
        <Show when={rightTab() === "team"}>
          <div class="panel-title">房间成员</div>
          <For each={roles()}>
            {(role) => {
              const busy = () => thinking().includes(role.displayName);
              return (
                <div class="member" classList={{ out: !role.inRoom }}>
                  <Avatar name={role.displayName} color={role.color} />
                  <div class="member-meta">
                    <div class="member-name">{role.displayName}</div>
                    <div class="member-desc">{role.description}</div>
                  </div>
                  <div class="member-actions">
                    <span class={`status-pill ${busy() ? "running" : ""}`}>
                      {busy() ? "思考中" : "在线"}
                    </span>
                    <Show when={canEditCurrentProject()}>
                      <button
                        class={`room-toggle ${role.inRoom ? "on" : ""}`}
                        title={role.inRoom ? "移出房间" : "加入房间"}
                        onClick={() => void toggleRoleInRoom(role.key, !role.inRoom)}
                      >
                        {role.inRoom ? "在房间" : "已移出"}
                      </button>
                    </Show>
                  </div>
                </div>
              );
            }}
          </For>
          <div class="panel-title" style={{ "margin-top": "14px" }}>
            在线成员
          </div>
          <Show when={presence().length} fallback={<div class="gate-note">当前没有其他在线成员。</div>}>
            <For each={presence()}>
              {(member) => (
                <div class="online-member">
                  <span class="presence-dot" />
                  <span class="online-name">{member.displayName}</span>
                  <span class="online-label">在线</span>
                </div>
              )}
            </For>
          </Show>
          <div class="gate-note">
            只有「在房间」的 Agent 会收到消息。移出后不再广播给他，需要时可以随时加回来。
            <br />
            用 <code>@pm</code>、<code>@architect</code>、<code>@frontend</code>、<code>@backend</code>、
            <code>@qa</code> 可以直接点名；被 @ 的人即使不在房间，也会被拉进本次讨论。
          </div>
        </Show>

        <Show when={rightTab() === "gate"}>
          <div class="panel-title">
            当前阶段 · {snap() ? PHASE_LABELS[snap()!.project.phase] : "—"}
          </div>
          <Show
            when={requirements().length}
            fallback={<div class="gate-note">这个阶段没有强制门禁，可以直接推进。</div>}
          >
            <For each={requirements()}>
              {(req) => (
                <div class={`gate ${req.met ? "met" : ""}`}>
                  <span class="tick">{req.met ? "✓" : "○"}</span>
                  <span>{req.label}</span>
                </div>
              )}
            </For>
          </Show>

          <Show when={snap()?.nextPhase}>
            <div class="gate-note">
              下一阶段：{PHASE_LABELS[snap()!.nextPhase!]}。正常由 AI 在门禁满足后发起阶段提议、你确认；手动推进只作为负责人兜底。敏捷循环（测试失败回 build、交付后开新一轮）也走同一确认流程。
            </div>
          </Show>

          <Show when={inReview().length}>
            <div class="panel-title" style={{ "margin-top": "14px" }}>
              待确认产物
            </div>
            <For each={inReview()}>
              {(artifact) => (
                <div class="approval">
                  <div class="approval-title">{artifact.title}</div>
                  <div class="run-meta">
                    {ARTIFACT_LABELS[artifact.kind] ?? artifact.kind} · v{artifact.currentVersion}
                  </div>
                  <div class="approval-actions">
                    <button class="btn" onClick={() => void openArtifact(artifact.id)}>
                      查看
                    </button>
                    <Show when={canEditCurrentProject()}>
                      <button class="btn primary" onClick={() => void decideArtifact(artifact.id, "accepted")}>
                        接受
                      </button>
                    </Show>
                  </div>
                </div>
              )}
            </For>
          </Show>

          <Show when={approvals().length}>
            <div class="panel-title" style={{ "margin-top": "14px" }}>
              待审批
            </div>            <For each={approvals()}>
              {(approval) => (
                <div class="approval">
                  <div class="approval-title">{approval.title}</div>
                  <div class="run-meta">{approval.targetType} · 由 {approval.requestedBy ?? "系统"} 发起</div>
                  <div class="approval-actions">
                    <Show when={canEditCurrentProject()}>
                      <button class="btn primary" onClick={() => void decideApproval(approval.id, "approved")}>
                        批准
                      </button>
                      <button class="btn danger" onClick={() => void decideApproval(approval.id, "rejected")}>
                        驳回
                      </button>
                    </Show>
                  </div>
                </div>
              )}
            </For>
          </Show>

          <Show when={decisions().length}>
            <div class="panel-title" style={{ "margin-top": "14px" }}>
              待确认决策
            </div>
            <For each={decisions()}>
              {(decision) => (
                <div class="approval">
                  <div class="approval-title">{decision.title}</div>
                  <div class="run-meta">{decision.rationale}</div>
                  <div class="approval-actions">
                    <Show when={canEditCurrentProject()}>
                      <button class="btn primary" onClick={() => void decideDecision(decision.id, "accepted")}>
                        接受
                      </button>
                      <button class="btn danger" onClick={() => void decideDecision(decision.id, "rejected")}>
                        拒绝
                      </button>
                    </Show>
                  </div>
                </div>
              )}
            </For>
          </Show>
        </Show>

        <Show when={rightTab() === "runs"}>
          <div class="panel-title">最近运行</div>
          <Show when={runs().length} fallback={<div class="empty">还没有运行记录</div>}>
            <For each={runs().slice(0, 20)}>
              {(run) => (
                <div class="run">
                  <div class="run-head">
                    <span class={`badge ${STATUS_CLASS[run.status] ?? ""}`}>{run.status}</span>
                    <span>{run.roleName ?? run.roleKey ?? "Agent"}</span>
                  </div>
                  <div class="run-meta">
                    {run.modelId ?? "default"}
                    {run.startedAt ? ` · ${new Date(run.startedAt).toLocaleTimeString("zh-CN")}` : ""}
                  </div>
                  <Show when={run.error}>
                    <div class="run-meta" style={{ color: "#fca5a5" }}>
                      {run.error}
                    </div>
                  </Show>
                </div>
              )}
            </For>
          </Show>
        </Show>
      </div>
    </aside>
  );
}
