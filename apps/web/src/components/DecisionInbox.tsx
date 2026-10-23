import { For, Show } from "solid-js";
import { ARTIFACT_LABELS } from "@devteam/contracts";
import {
  acceptPendingTechnicalArtifacts,
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
  const artifacts = () => snap()?.artifacts.filter((item) => item.status === "in_review") ?? [];
  const decisions = () => snap()?.decisions.filter((item) => item.status === "proposed") ?? [];
  const reviewTasks = () =>
    snap()?.tasks.filter((item) => ["review", "testing"].includes(item.status)) ?? [];
  const count = () => pendingDecisionCount(snap());
  const canDecide = () => canEditCurrentProject();
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
              <h3>待你决策</h3>
              <p>你需要先处理这些事项，自动开发才会继续。</p>
            </div>
            <span class="badge warn">{count()} 项</span>
            <button class="icon-btn" onClick={closeDecisionInbox} title="稍后处理">
              ✕
            </button>
          </div>

          <Show when={approvals().length}>
            <div class="decision-section-title">审批</div>
            <For each={approvals()}>
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
                      <Show when={Boolean(task.evidence?.["workspaceId"])}>
                        <button
                          class="btn primary"
                          onClick={() => {
                            if (window.confirm(`验收并合并「${task.title}」？`)) {
                              void mergeTaskWorkspace(task);
                            }
                          }}
                        >
                          验收合并
                        </button>
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
            <div class="decision-section-title">决策</div>
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
              <div class="decision-done-title">待决策项已处理完</div>
              <p>
                自动开发已暂停。确认没有遗漏后，再继续下一个任务；不会在你点按钮前自动开跑。
              </p>
              <Show when={snap()?.project.autoStartTasks === false}>
                <button class="btn primary" onClick={() => void resumeAutoDevelopment()}>
                  继续自动开发
                </button>
              </Show>
            </div>
          </Show>

          <Show when={count() && snap()?.project.autoStartTasks}>
            <div class="decision-note">
              还有待决策项时，自动开发会暂停。处理完后也不会自动继续，需要你点「继续自动开发」。
            </div>
          </Show>

          <div class="modal-actions">
            <span class="decision-foot-note">自动开发只负责开发；代码仍需测试、规格核对和人工验收合并。</span>
            <button class="btn" onClick={closeDecisionInbox}>
              稍后处理
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}
