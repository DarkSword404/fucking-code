import { For, Show, createSignal } from "solid-js";
import { ARTIFACT_LABELS } from "@devteam/contracts";
import { acceptPendingTechnicalArtifacts, openArtifact, snapshot } from "../lib/store";

const STATUS_CLASS: Record<string, string> = {
  accepted: "ok",
  in_review: "warn",
  rejected: "bad",
  superseded: "",
  draft: "",
};

export function ArtifactsView() {
  const [search, setSearch] = createSignal("");
  const allArtifacts = () => snapshot()?.artifacts ?? [];
  const artifacts = () => {
    const query = search().trim().toLowerCase();
    if (!query) return allArtifacts();
    return allArtifacts().filter((artifact) =>
      `${artifact.title} ${artifact.kind} ${artifact.status} ${artifact.artifactKey}`
        .toLowerCase()
        .includes(query),
    );
  };
  const pendingTechnical = () =>
    allArtifacts().filter(
      (artifact) =>
        artifact.status === "in_review" &&
        ["design", "api_contract", "plan", "note", "repo_analysis"].includes(artifact.kind),
    );

  return (
    <div class="page">
      <div class="page-inner">
        <div class="page-head">
          <h2>需求与产物</h2>
          <span class="sub">PRD、方案、接口契约、测试报告都会被版本化</span>
          <input
            class="search-input"
            placeholder="搜索产物…"
            value={search()}
            onInput={(event) => setSearch(event.currentTarget.value)}
          />
          <Show when={pendingTechnical().length}>
            <button
              class="btn primary"
              title="接受设计、契约、计划、备注等技术产物；PRD、验收标准、测试报告仍需逐项确认"
              onClick={() => void acceptPendingTechnicalArtifacts()}
            >
              接受技术产物 ({pendingTechnical().length})
            </button>
          </Show>
        </div>

        <Show
          when={artifacts().length}
          fallback={
            <div class="empty">
              还没有产物。PM 澄清需求后会生成 PRD 和验收标准；Architect 会生成技术方案。
            </div>
          }
        >
          <div class="artifact-grid">
            <For each={artifacts()}>
              {(artifact) => (
                <button class="artifact-card" onClick={() => void openArtifact(artifact.id)}>
                  <div class="artifact-kind">
                    {ARTIFACT_LABELS[artifact.kind] ?? artifact.kind} · v{artifact.currentVersion}
                  </div>
                  <div class="artifact-title">{artifact.title}</div>
                  <div class="artifact-summary">
                    更新于 {new Date(artifact.updatedAt).toLocaleString("zh-CN")}
                  </div>
                  <div class="artifact-foot">
                    <span class={`badge ${STATUS_CLASS[artifact.status] ?? ""}`}>{artifact.status}</span>
                  </div>
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
}
