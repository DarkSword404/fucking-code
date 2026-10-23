import { For } from "solid-js";
import { PHASE_LABELS, WORKFLOW_PHASES, type WorkflowPhase } from "@devteam/contracts";

export function PhaseBar(props: { current: WorkflowPhase }) {
  const currentIndex = () => WORKFLOW_PHASES.indexOf(props.current);
  return (
    <div class="phasebar" aria-label="研发阶段">
      <For each={WORKFLOW_PHASES}>
        {(phase, index) => (
          <div
            class={`phase ${phase === props.current ? "current" : ""} ${
              index() < currentIndex() ? "done" : ""
            }`}
            title={PHASE_LABELS[phase]}
          >
            <span class="phase-dot" />
            {PHASE_LABELS[phase]}
          </div>
        )}
      </For>
    </div>
  );
}
