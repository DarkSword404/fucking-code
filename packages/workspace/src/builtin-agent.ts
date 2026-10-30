import { createModelGateway, type ModelGateway } from "@devteam/agents";
import { writeFile } from "node:fs/promises";
import { jsonrepair } from "jsonrepair";
import {
  detectTestCommand,
  listFiles,
  readRepoContext,
  readWorkspaceFile,
  runCommand,
  writeWorkspaceFile,
} from "./manager.js";
import { BrowserSession } from "./browser-session.js";

export type BuiltinAgentMode = "code" | "workbench";

export interface BuiltinAgentInput {
  root: string;
  taskTitle: string;
  taskDescription: string;
  acceptance: string[];
  specText: string;
  previousFailure?: string;
  model: { providerID: string; id: string };
  gateway?: ModelGateway;
  mode?: BuiltinAgentMode;
  previewUrl?: string;
  seedUser?: string;
  seedPassword?: string;
  allowNetwork?: boolean;
  evidenceDir?: string;
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

function firstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

/**
 * DeepSeek sometimes emits its native tool-call markup instead of the JSON
 * contract. Accept the common invoke/parameter shape so a read or edit is not
 * turned into a wasted step.
 */
function parseDsml(text: string): ParsedAction | null {
  const invoke =
    /<[^>]*DSML[^>]*invoke\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/[^>]*invoke>/i.exec(text);
  if (!invoke) return null;
  const type = invoke[1] ?? "";
  if (!["read", "list", "run", "write", "edit", "fetch", "browser", "done"].includes(type)) {
    return null;
  }
  const args: Record<string, string> = {};
  for (const match of (invoke[2] ?? "").matchAll(
    /<[^>]*DSML[^>]*parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/[^>]*parameter>/gi,
  )) {
    const key = match[1] ?? "";
    const value = (match[2] ?? "").replace(/\n$/, "");
    if (key) args[key] = value;
  }
  return { action: { type, ...args } as ParsedAction["action"] };
}

function parseAction(text: string): ParsedAction {
  /**
   * Only accept an object that actually contains an `action` object. A later
   * code fence may contain arbitrary JSON/prose; preferring the text's own
   * first balanced object keeps a valid leading action from being discarded.
   */
  const parseCandidate = (value: string): ParsedAction | null => {
    const attempt = (raw: string): ParsedAction | null => {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (parsed.action && typeof parsed.action === "object") {
          return parsed as ParsedAction;
        }
        return null;
      } catch {
        return null;
      }
    };
    const direct = attempt(value);
    if (direct) return direct;
    const first = firstJsonObject(value);
    if (first) {
      const parsed = attempt(first);
      if (parsed) return parsed;
      try {
        const repaired = attempt(jsonrepair(first));
        if (repaired) return repaired;
      } catch {
        // fall through
      }
    }
    // Last resort: repair the whole value (raw newlines inside content).
    try {
      return attempt(jsonrepair(value));
    } catch {
      return null;
    }
  };

  const candidates = [text.trim()];
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    const body = (match[1] ?? "").trim();
    if (body) candidates.push(body);
  }
  for (const candidate of candidates) {
    const parsed = parseCandidate(candidate);
    if (parsed) return parsed;
  }
  const dsml = parseDsml(text);
  if (dsml) return dsml;
  return {};
}
function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}\n... (truncated)` : value;
}

function absolutePreview(previewUrl?: string): string | undefined {
  if (!previewUrl) return undefined;
  if (/^https?:\/\//i.test(previewUrl)) return previewUrl;
  const port = process.env.PORT ?? "8788";
  return `http://127.0.0.1:${port}${previewUrl.startsWith("/") ? "" : "/"}${previewUrl}`;
}

function codeSystemPrompt(testCommand: string | null): string {
  return [
    "You are a coding agent working in an isolated Git worktree.",
    "Reply with exactly one JSON object per turn, no markdown fences:",
    '{"thought":"...","action":{"type":"list"}}',
    '{"thought":"...","action":{"type":"read","path":"relative/path"}}',
    '{"thought":"...","action":{"type":"write","path":"relative/path","content":"full file content"}}',
    '{"thought":"...","action":{"type":"edit","path":"relative/path","old":"exact existing snippet","new":"replacement"}}',
    '{"thought":"...","action":{"type":"run","command":"npm test"}}',
    '{"thought":"...","action":{"type":"done","summary":"what changed, test result, remaining risk"}}',
    "",
    "Rules:",
    "- Output exactly one JSON object. No markdown fences, no explanation, no plan, no multiple actions.",
    "- Keep `thought` to one short sentence (max 200 characters). Never paste code, file contents, or observations into it.",
    "- Work only inside the worktree; use relative paths.",
    "- Inspect before editing; make small complete changes.",
    "- For an existing file you MUST use `edit` with an exact old snippet. `write` is only for new files; never rewrite an existing large file.",
    "- Run the test command after changes. Do not claim success without the command output.",
    "- Do not run git push, git merge/rebase to main, rm -rf, or read .env.",
    "- If the task is already satisfied, run tests once and done.",
    testCommand
      ? `- Test command: ${testCommand}`
      : "- There is no test command; use node --check or a relevant command.",
  ].join("\n");
}

function workbenchSystemPrompt(): string {
  return [
    "You are a read-only QA / security / deployment verification agent.",
    "You work inside an isolated worktree. Reply with exactly one JSON object per turn, no markdown fences.",
    "",
    "Actions:",
    '{"thought":"...","action":{"type":"list"}}',
    '{"thought":"...","action":{"type":"read","path":"relative/path"}}',
    '{"thought":"...","action":{"type":"run","command":"npm test"}}',
    '{"thought":"...","action":{"type":"fetch","url":"http://...","method":"GET"}}',
    '{"thought":"...","action":{"type":"browser","action":"open","url":"http://..."}}',
    '{"thought":"...","action":{"type":"browser","action":"snapshot"}}',
    '{"thought":"...","action":{"type":"browser","action":"click","selector":"#submit"}}',
    '{"thought":"...","action":{"type":"browser","action":"click","text":"登录"}}',
    '{"thought":"...","action":{"type":"browser","action":"fill","selector":"input[name=email]","value":"..."}}',
    '{"thought":"...","action":{"type":"browser","action":"press","key":"Enter"}}',
    '{"thought":"...","action":{"type":"browser","action":"screenshot","path":"docs/qa-evidence/step-1.png"}}',
    '{"thought":"...","action":{"type":"browser","action":"eval","script":"document.title"}}',
    '{"thought":"...","action":{"type":"browser","action":"text"}}',
    '{"thought":"...","action":{"type":"write","path":"docs/qa-evidence/report.md","content":"..."}}',
    '{"thought":"...","action":{"type":"edit","path":"docs/qa-evidence/report.md","old":"exact snippet","new":"replacement"}}',
    '{"thought":"...","action":{"type":"done","summary":"per-item result, uncovered items, reproduction steps, residual risk"}}',
    "",
    "Rules:",
    "- Output exactly one JSON object. No markdown fences, no explanation, no multiple actions.",
    "- This is a read-only verification. Do not modify product code. Evidence and reports may only be written under docs/ or qa-evidence/.",
    "- Use the provided preview URL first. Do not start a second app instance unless the preview is broken; if you must, use a random PORT and stop it afterwards.",
    "- Every conclusion needs evidence: command output, HTTP status/body, browser snapshot, or screenshot path. Never guess a pass.",
    "- For login, use the provided test account; never write the password into the report.",
    "- Uncovered checks must be labeled 未覆盖/无法执行.",
    "- Do not read .env, git push/merge, rm -rf, or touch files outside the worktree.",
    "- Use `browser` actions in small steps: open -> snapshot -> fill/click -> snapshot. Screenshots go under docs/qa-evidence/.",
    "- Finish with `done`; the summary must cover every acceptance item.",
  ].join("\n");
}

function observationFor(result: { status: string; exitCode: number | null; output: string }): string {
  return `${result.status} exit ${result.exitCode}\n${clip(result.output, 20_000)}`;
}

/**
 * A small model-driven loop used when CODE_EXECUTOR/WORKBENCH_EXECUTOR=builtin.
 * It talks to the inference gateway only; file access, commands, HTTP and the
 * browser are executed by Fucking Code itself, so no OpenCode session/tool
 * runtime is required.
 */
/**
 * Worktrees share the base repository's dependency directory (read-only).
 * Running an installer inside the sandbox cannot work, and with network off it
 * burns the whole command timeout before failing. Refuse it immediately.
 */
export function isDependencyInstallCommand(command: string): boolean {
  const parts = command.split(/&&|\|\||;/);
  for (const raw of parts) {
    let part = raw.trim().toLowerCase();
    // `cd /workspace && npm ci` is the common shape.
    part = part.replace(/^cd\s+\S+\s*/, "").replace(/^sudo\s+/, "");
    const tokens = part.split(/\s+/).filter(Boolean);
    while (tokens.length && /^[a-z_][a-z0-9_]*=/.test(tokens[0]!)) tokens.shift();
    const pm = tokens.shift();
    if (!["npm", "yarn", "pnpm", "bun"].includes(pm ?? "")) continue;
    if (!tokens.length && (pm === "yarn" || pm === "pnpm" || pm === "bun")) return true;
    // Skip `--prefix <dir>`-style flag values before looking for the verb.
    const verb = tokens.find(
      (token, index) =>
        !token.startsWith("-") && !["--prefix", "--cwd", "-c", "-C"].includes(tokens[index - 1] ?? ""),
    );
    if (verb === "ci" || verb === "install" || verb === "i" || verb === "add") return true;
  }
  return false;
}

function isRetryableModelError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out|aborted|ECONNRESET|ECONNREFUSED|fetch failed|socket hang up|503|502|504/i.test(
    message,
  );
}

/**
 * Retry one transient gateway failure before failing the whole task. A timeout
 * is retried only when the remaining task budget can absorb another full call;
 * otherwise retrying just doubles the silence and still fails.
 */
async function generateWithRetry(
  gateway: Pick<ModelGateway, "generateText">,
  request: Parameters<ModelGateway["generateText"]>[0],
  deadline?: number,
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await gateway.generateText(request);
    } catch (error) {
      lastError = error;
      if (request.signal?.aborted || !isRetryableModelError(error)) throw error;
      // A fast failure leaves most of the budget intact; only skip the retry
      // when the task is nearly out of time.
      if (deadline !== undefined && deadline - Date.now() < 10_000) throw error;
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("model gateway failed");
}

export async function runBuiltinAgent(input: BuiltinAgentInput): Promise<BuiltinAgentResult> {
  const gateway = input.gateway ?? createModelGateway();
  const mode: BuiltinAgentMode = input.mode ?? "code";
  const isWorkbench = mode === "workbench";
  const maxSteps = Number(
    input.maxSteps ??
      (isWorkbench
        ? process.env.WORKBENCH_MAX_STEPS ?? 40
        : process.env.CODE_AGENT_MAX_STEPS ?? 20),
  );
  const timeoutMs = Number(
    input.timeoutMs ??
      (isWorkbench
        ? process.env.WORKBENCH_TIMEOUT_MS ?? 30 * 60_000
        : process.env.CODE_AGENT_TIMEOUT_MS ?? 20 * 60_000),
  );
  const deadline = Date.now() + timeoutMs;
  const network = input.allowNetwork ?? (isWorkbench || process.env.CODE_TASK_NETWORK === "1");
  const testCommand = await detectTestCommand(input.root);
  const repoContext = await readRepoContext(input.root).catch(() => "");
  const initialTest =
    testCommand && !isWorkbench
      ? await runCommand(input.root, testCommand, 120_000, { network })
      : null;
  const previewUrl = absolutePreview(input.previewUrl);
  const banner = [
    `Task: ${input.taskTitle}`,
    `Description: ${input.taskDescription}`,
    "Acceptance:",
    ...(input.acceptance.length ? input.acceptance.map((item) => `- ${item}`) : ["- (none)"]),
    input.previousFailure ? `\nPrevious failure (must address):\n${input.previousFailure}` : "",
    input.specText ? `\nConfirmed spec:\n${clip(input.specText, 20_000)}` : "",
    isWorkbench
      ? [
          previewUrl ? `\nPreview URL: ${previewUrl}` : "\nNo preview URL was provided.",
          `Test account: ${input.seedUser ?? "security"}`,
          `Test password: ${input.seedPassword ?? "（platform default）"}（never write this into reports）`,
        ].join("\n")
      : "",
    `\nRepository context:\n${clip(repoContext, 20_000)}`,
    initialTest
      ? `\nInitial test run (${initialTest.status}, exit ${initialTest.exitCode}):\n${clip(initialTest.output, 10_000)}`
      : isWorkbench
        ? "\nRun the project test command only if it helps verify the task."
        : "\nNo initial test command.",
  ]
    .filter(Boolean)
    .join("\n");

  let transcript = banner;
  let summary = "";
  let toolCalls = 0;
  let steps = 0;
  let outcome: BuiltinAgentResult["outcome"] = "failed";
  let browserSession: BrowserSession | null = null;

  const system = isWorkbench ? workbenchSystemPrompt() : codeSystemPrompt(testCommand);

  try {
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
      if (transcript.length > 160_000) {
        transcript = `... earlier steps omitted ...\n${transcript.slice(-120_000)}`;
      }

      // A single long generation (large patch, long file) can legitimately take
      // minutes. The per-call cap must not be shorter than the task budget, or
      // healthy work dies as a fake "channel timeout".
      const callTimeoutMs = Number(process.env.MODEL_CALL_TIMEOUT_MS ?? 300_000);
      const callStarted = Date.now();
      const text = await generateWithRetry(
        gateway,
        {
          system,
          prompt: transcript,
          model: input.model,
          signal: input.signal,
          timeoutMs: Math.max(10_000, Math.min(callTimeoutMs, deadline - Date.now())),
        },
        deadline,
      );
      console.log(
        `[builtin] task=${input.taskTitle.slice(0, 12).replace(/\s+/g, "_")} step=${steps} prompt=${transcript.length} out=${text.length} ms=${Date.now() - callStarted}`,
      );
      const parsed = parseAction(text);
      const action = parsed.action;
      if (!action || typeof action.type !== "string") {
        const dump = `/tmp/fc-invalid-action-${process.pid}-${steps}.txt`;
        await writeFile(dump, text).catch(() => undefined);
        console.error(
          `[builtin] invalid action step=${steps} len=${text.length} dump=${dump} head=${text.slice(0, 160).replace(/\s+/g, " ")} tail=${text.slice(-160).replace(/\s+/g, " ")}`,
        );
        transcript += `\n\nAssistant: ${clip(text, 2000)}\nObservation: invalid action JSON. Reply with exactly one action object, no markdown or explanation.`;
        continue;
      }

      toolCalls += 1;
      console.log(
        `[builtin] action=${action.type} target=${String(action.path ?? action.command ?? action.url ?? "").slice(0, 160)}`,
      );
      const label =
        action.type === "browser"
          ? `browser:${String(action.action ?? "snapshot")}`
          : String(action.type === "run" ? "run" : action.type);
      await input.onProgress?.(label);
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
          if (isWorkbench) {
            const normalized = path.replace(/^\.\//, "");
            if (!normalized.startsWith("docs/") && !normalized.startsWith("qa-evidence/")) {
              throw new Error("workbench may only write evidence under docs/ or qa-evidence/");
            }
          }
          const content = String(action.content ?? "");
          // A full rewrite of an existing file is the main cause of 10-minute
          // generations and unusable truncated JSON. Force targeted edits.
          const existing = await readWorkspaceFile(input.root, path).catch(() => null);
          if (existing !== null && existing.length > 1_000 && content.length > 4_000) {
            throw new Error(
              "write refused: this file already exists and is non-trivial; use edit with an exact snippet instead of rewriting it",
            );
          }
          await writeWorkspaceFile(input.root, path, content);
          transcript += `\n\nAction: write ${path}\nObservation: file written (${String(action.content ?? "").length} chars)`;
        } else if (action.type === "edit") {
          const path = String(action.path ?? "");
          if (isWorkbench) {
            const normalized = path.replace(/^\.\//, "");
            if (!normalized.startsWith("docs/") && !normalized.startsWith("qa-evidence/")) {
              throw new Error("workbench may only edit evidence under docs/ or qa-evidence/");
            }
          }
          const oldText = String(action.old ?? action.oldString ?? "");
          const newText = String(action.new ?? action.newString ?? "");
          if (!oldText) throw new Error("edit requires a non-empty old snippet");
          const original = await readWorkspaceFile(input.root, path);
          const index = original.indexOf(oldText);
          if (index < 0) {
            throw new Error("edit target not found; read the file and copy the exact existing snippet");
          }
          if (original.indexOf(oldText, index + oldText.length) >= 0) {
            throw new Error("edit target is ambiguous; include more surrounding context");
          }
          await writeWorkspaceFile(
            input.root,
            path,
            original.slice(0, index) + newText + original.slice(index + oldText.length),
          );
          transcript += `\n\nAction: edit ${path}\nObservation: replaced ${oldText.length} chars with ${newText.length} chars`;
        } else if (action.type === "run") {
          const command = String(action.command ?? "").trim();
          if (!command) throw new Error("empty command");
          if (isDependencyInstallCommand(command)) {
            transcript += `\n\nAction: run ${command}\nObservation: 依赖目录由主仓库只读共享，安装命令已拒绝；直接运行测试，缺依赖请报告缺口。`;
          } else {
            const result = await runCommand(input.root, command, 180_000, { network });
            transcript += `\n\nAction: run ${command}\nObservation: ${observationFor(result)}`;
          }
        } else if (action.type === "fetch") {
          if (!isWorkbench) throw new Error("fetch is only available in workbench mode");
          const rawUrl = String(action.url ?? "").trim();
          const url = new URL(rawUrl);
          if (!["http:", "https:"].includes(url.protocol)) {
            throw new Error("fetch only supports http/https");
          }
          const method = String(action.method ?? "GET").toUpperCase();
          const headers =
            action.headers && typeof action.headers === "object"
              ? Object.fromEntries(
                  Object.entries(action.headers as Record<string, unknown>).map(([key, value]) => [
                    key,
                    String(value),
                  ]),
                )
              : undefined;
          const body =
            action.body === undefined
              ? undefined
              : typeof action.body === "string"
                ? action.body
                : JSON.stringify(action.body);
          const response = await fetch(url, {
            method,
            headers,
            body: method === "GET" || method === "HEAD" ? undefined : body,
            redirect: "manual",
            signal: AbortSignal.any([
              AbortSignal.timeout(30_000),
              ...(input.signal ? [input.signal] : []),
            ]),
          });
          const responseText = await response.text();
          const responseHeaders = Object.fromEntries(response.headers.entries());
          transcript += `\n\nAction: fetch ${method} ${rawUrl}\nObservation: HTTP ${response.status}\nHeaders: ${JSON.stringify(
            responseHeaders,
          )}\nBody:\n${clip(responseText, 12_000)}`;
        } else if (action.type === "browser") {
          if (!isWorkbench) throw new Error("browser is only available in workbench mode");
          browserSession ??= new BrowserSession(
            input.root,
            input.evidenceDir ?? "docs/qa-evidence",
          );
          const sub = String(action.action ?? "snapshot");
          let observation: string;
          if (sub === "open" || sub === "goto" || sub === "navigate") {
            const target = String(action.url ?? "").trim();
            if (!target) throw new Error("browser open requires url");
            observation = await browserSession.open(target);
          } else if (sub === "snapshot" || sub === "inspect") {
            observation = await browserSession.snapshot();
          } else if (sub === "click") {
            observation = await browserSession.click(action);
          } else if (sub === "fill" || sub === "type") {
            observation = await browserSession.fill(action);
          } else if (sub === "press") {
            observation = await browserSession.press(action);
          } else if (sub === "select") {
            observation = await browserSession.select(action);
          } else if (sub === "screenshot") {
            observation = `screenshot saved: ${await browserSession.screenshot(action)}`;
          } else if (sub === "eval" || sub === "evaluate") {
            observation = await browserSession.evaluate(action);
          } else if (sub === "text") {
            observation = await browserSession.text();
          } else if (sub === "close") {
            await browserSession.close();
            observation = "browser closed";
          } else {
            throw new Error(`unknown browser action: ${sub}`);
          }
          transcript += `\n\nAction: browser ${sub}\nObservation:\n${clip(observation, 20_000)}`;
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
  } finally {
    await browserSession?.close();
  }

  if (outcome === "succeeded" && !summary) summary = "Agent marked the task done.";
  if (outcome === "failed" && !summary) summary = "Agent stopped before finishing.";
  return { summary, transcript, toolCalls, outcome };
}
