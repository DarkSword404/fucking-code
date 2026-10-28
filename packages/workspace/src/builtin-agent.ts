import { createModelGateway, type ModelGateway } from "@devteam/agents";
import {
  detectTestCommand,
  listFiles,
  readRepoContext,
  readWorkspaceFile,
  runCommand,
  writeWorkspaceFile,
} from "./manager.js";

export interface BuiltinAgentInput {
  root: string;
  taskTitle: string;
  taskDescription: string;
  acceptance: string[];
  specText: string;
  previousFailure?: string;
  model: { providerID: string; id: string };
  gateway?: ModelGateway;
  maxSteps?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (tool: string) => Promise<void> | void;
}

export interface BuiltinAgentResult {
  summary: string;
  transcript: string;
  toolCalls: number;
  outcome: "succeeded" | "failed" | "timeout" | "cancelled";
}

interface ParsedAction {
  thought?: string;
  action?: Record<string, unknown>;
}

function parseAction(text: string): ParsedAction {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  const parse = (value: string): ParsedAction => {
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      if (parsed.action && typeof parsed.action === "object") {
        return parsed as ParsedAction;
      }
      return { action: parsed };
    } catch {
      return {};
    }
  };
  const direct = parse(candidate);
  if (direct.action) return direct;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start >= 0 && end > start) return parse(candidate.slice(start, end + 1));
  return {};
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}\n... (truncated)` : value;
}

/**
 * A small model-driven code loop used when CODE_EXECUTOR=builtin. It talks to
 * the inference gateway only; file access and commands are executed by Fucking
 * Code itself, so no OpenCode session/tool runtime is required.
 */
export async function runBuiltinAgent(input: BuiltinAgentInput): Promise<BuiltinAgentResult> {
  const gateway = input.gateway ?? createModelGateway();
  const maxSteps = Number(input.maxSteps ?? process.env.CODE_AGENT_MAX_STEPS ?? 20);
  const timeoutMs = Number(input.timeoutMs ?? process.env.CODE_AGENT_TIMEOUT_MS ?? 20 * 60_000);
  const deadline = Date.now() + timeoutMs;
  const testCommand = await detectTestCommand(input.root);
  const repoContext = await readRepoContext(input.root).catch(() => "");
  const initialTest = testCommand
    ? await runCommand(input.root, testCommand, 120_000, {
        network: process.env.CODE_TASK_NETWORK === "1",
      })
    : null;

  const system = [
    "You are a coding agent working in an isolated Git worktree.",
    "Reply with exactly one JSON object per turn, no markdown fences:",
    '{"thought":"...","action":{"type":"list"}}',
    '{"thought":"...","action":{"type":"read","path":"relative/path"}}',
    '{"thought":"...","action":{"type":"write","path":"relative/path","content":"full file content"}}',
    '{"thought":"...","action":{"type":"run","command":"npm test"}}',
    '{"thought":"...","action":{"type":"done","summary":"what changed, test result, remaining risk"}}',
    "",
    "Rules:",
    "- Work only inside the worktree; use relative paths.",
    "- Inspect before editing; make small complete changes.",
    "- Run the test command after changes. Do not claim success without the command output.",
    "- Do not run git push, git merge/rebase to main, rm -rf, or read .env.",
    "- If the task is already satisfied, run tests once and done.",
    testCommand ? `- Test command: ${testCommand}` : "- There is no test command; use node --check or a relevant command.",
  ].join("\n");

  let transcript = [
    `Task: ${input.taskTitle}`,
    `Description: ${input.taskDescription}`,
    "Acceptance:",
    ...(input.acceptance.length ? input.acceptance.map((item) => `- ${item}`) : ["- (none)"]),
    input.previousFailure ? `\nPrevious failure (must address):\n${input.previousFailure}` : "",
    input.specText ? `\nConfirmed spec:\n${clip(input.specText, 20_000)}` : "",
    `\nRepository context:\n${clip(repoContext, 20_000)}`,
    initialTest
      ? `\nInitial test run (${initialTest.status}, exit ${initialTest.exitCode}):\n${clip(initialTest.output, 10_000)}`
      : "\nNo initial test command.",
  ]
    .filter(Boolean)
    .join("\n");

  let summary = "";
  let toolCalls = 0;
  let steps = 0;
  let outcome: BuiltinAgentResult["outcome"] = "failed";

  while (steps < maxSteps) {
    if (input.signal?.aborted) {
      outcome = "cancelled";
      break;
    }
    if (Date.now() >= deadline) {
      outcome = "timeout";
      break;
    }
    steps += 1;
    if (transcript.length > 140_000) {
      transcript = `... earlier steps omitted ...\n${transcript.slice(-100_000)}`;
    }

    const text = await gateway.generateText({
      system,
      prompt: transcript,
      model: input.model,
      signal: input.signal,
      timeoutMs: Math.min(90_000, Math.max(10_000, deadline - Date.now())),
    });
    const parsed = parseAction(text);
    const action = parsed.action;
    if (!action || typeof action.type !== "string") {
      transcript += `\n\nAssistant: ${clip(text, 2000)}\nObservation: invalid action JSON. Reply with one action object only.`;
      continue;
    }

    toolCalls += 1;
    await input.onProgress?.(String(action.type === "run" ? "run" : action.type));
    try {
      if (action.type === "list") {
        const files = await listFiles(input.root);
        transcript += `\n\nAction: list\nObservation:\n${files
          .slice(0, 400)
          .map((file) => `${file.status} ${file.path}`)
          .join("\n")}`;
      } else if (action.type === "read") {
        const path = String(action.path ?? "");
        const content = await readWorkspaceFile(input.root, path);
        transcript += `\n\nAction: read ${path}\nObservation:\n${clip(content, 30_000)}`;
      } else if (action.type === "write") {
        const path = String(action.path ?? "");
        await writeWorkspaceFile(input.root, path, String(action.content ?? ""));
        transcript += `\n\nAction: write ${path}\nObservation: file written (${String(action.content ?? "").length} chars)`;
      } else if (action.type === "run") {
        const command = String(action.command ?? "").trim();
        if (!command) throw new Error("empty command");
        const result = await runCommand(input.root, command, 180_000, {
          network: process.env.CODE_TASK_NETWORK === "1",
        });
        transcript += `\n\nAction: run ${command}\nObservation: ${result.status} exit ${result.exitCode}\n${clip(
          result.output,
          20_000,
        )}`;
      } else if (action.type === "done") {
        summary = String(action.summary ?? "").trim();
        outcome = "succeeded";
        break;
      } else {
        transcript += `\n\nAction: ${JSON.stringify(action)}\nObservation: unknown action type.`;
      }
    } catch (error) {
      transcript += `\n\nAction: ${JSON.stringify(action)}\nObservation: error: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  }

  if (outcome === "succeeded" && !summary) summary = "Agent marked the task done.";
  if (outcome === "failed" && !summary) summary = "Agent stopped before finishing.";
  return { summary, transcript, toolCalls, outcome };
}
