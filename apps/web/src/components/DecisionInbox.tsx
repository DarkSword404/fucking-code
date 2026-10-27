import { For, Show, createSignal } from "solid-js";
import { ARTIFACT_LABELS, PHASE_LABELS } from "@devteam/contracts";
import {
  acceptPendingTechnicalArtifacts,
  autoStartError,
  canEditCurrentProject,
  closeDecisionInbox,
  mergeTaskWorkspace,
  openTaskCode,
  updateTask,
  decideApproval,
  decideArtifact,
  decideDecision,
  decisionOpen,
  openArtifact,
  pendingDecisionCount,
  resumeAutoDevelopment,
  snapshot,
} from "../lib/store";

export function DecisionInbox() {
  const snap = () => snapshot();
  const approvals = () => snap()?.approvals.filter((item) => item.status === "pending") ?? [];
  const phaseTargetOf = (targetType: string): string | null =>
    targetType.startsWith("phase_transition:")
      ? targetType.slice("phase_transition:".length)
      : null;
  const phaseApprovals = () => approvals().filter((item) => phaseTargetOf(item.targetType));
  const otherApprovals = () => approvals().filter((item) => !phaseTargetOf(item.targetType));
  const artifacts = () => snap()?.artifacts.filter((item) => item.status === "in_review") ?? [];
  const decisions = () => snap()?.decisions.filter((item) => item.status === "proposed") ?? [];
  const reviewTasks = () =>
    snap()?.tasks.filter((item) => ["review", "testing"].includes(item.status)) ?? [];
  const count = () => pendingDecisionCount(snap());
  const canDecide = () => canEditCurrentProject();
  const hasRepo = () => Boolean(snap()?.project.repoPath);
  const [mergingTaskId, setMergingTaskId] = createSignal<string | null>(null);
  const isTaskRunning = (taskId: string) =>
    Boolean(
      snap()?.runs.some(
        (run) => run.status === "running" && run.metadata?.["taskId"] === taskId,
      ),
    );
  const verificationOf = (task: { evidence?: Record<string, unknown> }) =>
    task.evidence?.["verification"] as { verdict?: string } | undefined;
  const canMergeTask = (task: {
    id: string;
    status: string;
    evidence?: Record<string, unknown>;
  }) =>
    task.status === "review" &&
    Boolean(task.evidence?.["workspaceId"]) &&
    verificationOf(task)?.verdict === "pass" &&
    !isTaskRunning(task.id);
  const technical = () =>
    artifacts().filter((item) =>
      ["design", "api_contract", "plan", "note", "repo_analysis", "diff", "test_report", "spec_review"].includes(item.kind),
    );

  return (
    <Show when={decisionOpen()}>
      <div class="modal-scrim decision-scrim" onClick={closeDecisionInbox}>
        <div class="modal decision-modal" onClick={(event) => event.stopPropagation()}>
          <div class="decision-head">
            <div>
              <h3>需要你确认的产品事项</h3>
              <p>你需要先处理这些事项，自动开发才会继续。</p>
            </div>
            <span class="badge warn">{count()} 项</span>
            <button class="icon-btn" onClick={closeDecisionInbox} title="稍后处理">
              ✕
            </button>
          </div>

          <Show when={phaseApprovals().length}>
            <div class="decision-section-title">阶段确认</div>
            <For each={phaseApprovals()}>
              {(approval) => {
                const target = () => phaseTargetOf(approval.targetType);
                return (
                  <div class="decision-item phase-decision">
                    <div class="decision-item-main">
                      <div class="decision-item-title">{approval.title}</div>
                      <div class="decision-item-meta">
                        AI 阶段提议 · 由 {approval.requestedBy ?? "团队"} 发起 · 批准后进入「
                        {target() ? PHASE_LABELS[target()! as keyof typeof PHASE_LABELS] ?? target() : "下一阶段"}」
                      </div>
                      <Show when={approval.reason}>
                        <div class="decision-item-reason">{approval.reason}</div>
                      </Show>
                    </div>
                    <Show when={canDecide()}>
                      <div class="decision-actions">
                        <button class="btn primary" onClick={() => void decideApproval(approval.id, "approved")}>
                          进入阶段
                        </button>
                        <button class="btn danger" onClick={() => void decideApproval(approval.id, "rejected")}>
                          保持当前
                        </button>
                      </div>
                    </Show>
                  </div>
                );
              }}
            </For>
            <div class="decision-note">
              AI 只负责提议和说明理由；你批准后才会推进。阶段推进不会自动开跑，仍需你点「继续自动开发」。
            </div>
          </Show>

          <Show when={otherApprovals().length}>
            <div class="decision-section-title">审批</div>
            <For each={otherApprovals()}>
              {(approval) => (
                <div class="decision-item">
                  <div class="decision-item-main">
                    <div class="decision-item-title">{approval.title}</div>
                    <div class="decision-item-meta">
                      {approval.targetType} · 由 {approval.requestedBy ?? "系统"} 发起
                    </div>
                    <Show when={approval.reason}>
                      <div class="decision-item-reason">{approval.reason}</div>
                    </Show>
                  </div>
                  <Show when={canDecide()}>
                    <div class="decision-actions">
                      <button class="btn primary" onClick={() => void decideApproval(approval.id, "approved")}>
                        批准
                      </button>
                      <button class="btn danger" onClick={() => void decideApproval(approval.id, "rejected")}>
                        驳回
                      </button>
                    </div>
                  </Show>
                </div>
              )}
            </For>
          </Show>

          <Show when={reviewTasks().length}>
            <div class="decision-section-title">任务验收</div>
            <For each={reviewTasks()}>
              {(task) => (
                <div class="decision-item">
                  <div class="decision-item-main">
                    <div class="decision-item-title">{task.title}</div>
                    <div class="decision-item-meta">
                      {task.status} · {task.roleKey ?? "未指定负责人"} · 验收标准 {task.acceptance.length} 条
                    </div>
                    <Show when={task.blockedReason}>
                      <div class="decision-item-reason">{task.blockedReason}</div>
                    </Show>
                  </div>
                  <Show when={canDecide()}>
                    <div class="decision-actions">
                      <button
                        class="btn"
                        onClick={() => {
                          closeDecisionInbox();
                          openTaskCode(task);
                        }}
                      >
                        查看变更
                      </button>
                      <Show when={canMergeTask(task)}>
                        <button
                          class="btn primary"
                          disabled={mergingTaskId() === task.id}
                          onClick={async () => {
                            if (!window.confirm(`验收并合并「${task.title}」？`)) return;
                            setMergingTaskId(task.id);
                            try {
                              await mergeTaskWorkspace(task);
                            } finally {
                              setMergingTaskId(null);
                            }
                          }}
                        >
                          {mergingTaskId() === task.id ? "合并中…" : "验收合并"}
                        </button>
                      </Show>
                      <Show when={Boolean(task.evidence?.["workspaceId"]) && !canMergeTask(task)}>
                        <span class="decision-hint">
                          {isTaskRunning(task.id)
                            ? "验证中，完成后才能验收合并"
                            : task.status === "testing"
                              ? "验证中，完成后才能验收合并"
                              : "规格核对未通过，暂不能合并"}
                        </span>
                      </Show>
                      <Show when={!task.evidence?.["workspaceId"]}>
                        <button
                          class="btn"
                          onClick={() =>
                            void updateTask(task.id, {
                              status: "done",
                              expectedUpdatedAt: task.updatedAt,
                            })
                          }
                        >
                          标记完成
                        </button>
                      </Show>
                    </div>
                  </Show>
                </div>
              )}
            </For>
          </Show>

          <Show when={artifacts().length}>
            <div class="decision-section-title">
              产物确认
              <Show when={technical().length}>
                <button
                  class="btn"
                  style={{ "margin-left": "auto", padding: "2px 7px", "font-size": "10px" }}
                  onClick={() => void acceptPendingTechnicalArtifacts()}
                >
                  接受全部技术产物 ({technical().length})
                </button>
              </Show>
            </div>
            <For each={artifacts()}>
              {(artifact) => (
                <div class="decision-item">
                  <div class="decision-item-main">
                    <div class="decision-item-title">{artifact.title}</div>
                    <div class="decision-item-meta">
                      {ARTIFACT_LABELS[artifact.kind] ?? artifact.kind} · v{artifact.currentVersion}
                    </div>
                  </div>
                  <div class="decision-actions">
                    <button
                      class="btn"
                      onClick={() => {
                        closeDecisionInbox();
                        void openArtifact(artifact.id);
                      }}
                    >
                      查看
                    </button>
                    <Show when={canDecide()}>
                      <button class="btn primary" onClick={() => void decideArtifact(artifact.id, "accepted")}>
                        接受
                      </button>
                      <button class="btn danger" onClick={() => void decideArtifact(artifact.id, "rejected")}>
                        退回
                      </button>
                    </Show>
                  </div>
                </div>
              )}
            </For>
          </Show>

          <Show when={decisions().length}>
            <div class="decision-section-title">产品决策（不阻塞开发）</div>
            <For each={decisions()}>
              {(decision) => (
                <div class="decision-item">
                  <div class="decision-item-main">
                    <div class="decision-item-title">{decision.title}</div>
                    <Show when={decision.rationale}>
                      <div class="decision-item-reason">{decision.rationale}</div>
                    </Show>
                  </div>
                  <Show when={canDecide()}>
                    <div class="decision-actions">
                      <button class="btn primary" onClick={() => void decideDecision(decision.id, "accepted")}>
                        接受
                      </button>
                      <button class="btn danger" onClick={() => void decideDecision(decision.id, "rejected")}>
                        拒绝
                      </button>
                    </div>
                  </Show>
                </div>
              )}
            </For>
          </Show>

          <Show when={!count()}>
            <div class="decision-done">
              <div class="decision-done-title">没有阻塞项</div>
              <p>
                编码、测试、规格核对和合并由团队内部自动完成，不需要你逐项确认。
              </p>
              <Show when={!hasRepo()}>
                <div class="decision-note">
                  这个项目还没有仓库路径；点「继续自动开发」会自动创建一个隔离的空 Git 仓库，不需要你手动配置。
                </div>
              </Show>
              <Show when={snap()?.project.autoStartTasks === false}>
                <button class="btn primary" onClick={() => void resumeAutoDevelopment()}>
                  继续自动开发
                </button>
              </Show>
              <Show when={autoStartError()}>
                <div class="decision-error">{autoStartError()}</div>
              </Show>
            </div>
          </Show>

          <Show when={count() && snap()?.project.autoStartTasks}>
            <div class="decision-note">
              产品决策不会阻塞编码/测试；只有产品审批会暂停队列。暂停项处理完后会自动继续，无需手动点「继续自动开发」。
            </div>
          </Show>

          <div class="modal-actions">
            <span class="decision-foot-note">工程流程由团队内部完成；这里只处理产品范围、优先级和产品审批。</span>
            <button class="btn" onClick={closeDecisionInbox}>
              稍后处理
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}
