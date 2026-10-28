import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createModelGateway } from "@devteam/agents";

const root = await mkdtemp(join(tmpdir(), "fc-builtin-agent-"));
const gateway = createModelGateway();
const provider = process.env.AGENT_MODEL_PROVIDER ?? "opencode-go";
const modelId = process.env.AGENT_MODEL_ID ?? "deepseek-v4.1-flash";

await mkdir(join(root, "src"), { recursive: true });
await mkdir(join(root, "test"), { recursive: true });
await writeFile(
  join(root, "package.json"),
  JSON.stringify(
    { name: "builtin-agent-smoke", private: true, type: "module", scripts: { test: "node --test" } },
    null,
    2,
  ),
);
await writeFile(
  join(root, "src/add.js"),
  "export function add(a, b) {\n  return a - b;\n}\n",
);
await writeFile(
  join(root, "test/add.test.js"),
  [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { add } from '../src/add.js';",
    "",
    "test('adds two numbers', () => {",
    "  assert.equal(add(2, 3), 5);",
    "});",
    "",
  ].join("\n"),
);

function run(command: string): { code: number; output: string } {
  const result = spawnSync("npm", ["test"], {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000,
  });
  return { code: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function inside(rel: string): string {
  const target = resolve(root, rel);
  if (relative(root, target).startsWith("..")) throw new Error("path escapes workspace");
  return target;
}

function parseAction(text: string): { action?: Record<string, unknown>; thought?: string } {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>;
    if (parsed.action && typeof parsed.action === "object") return parsed as { action: Record<string, unknown> };
    return { action: parsed };
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
        if (parsed.action && typeof parsed.action === "object") return parsed as { action: Record<string, unknown> };
        return { action: parsed };
      } catch {
        return {};
      }
    }
    return {};
  }
}

const initial = run("npm test");
let transcript = [
  "Initial files:",
  "--- package.json ---",
  await readFile(join(root, "package.json"), "utf8"),
  "--- src/add.js ---",
  await readFile(join(root, "src/add.js"), "utf8"),
  "--- test/add.test.js ---",
  await readFile(join(root, "test/add.test.js"), "utf8"),
  "Initial test output:",
  initial.output.slice(-4000),
].join("\n");

const system = [
  "You are a coding agent working in a temporary Git workspace.",
  "Reply with exactly one JSON object, no markdown, using one of:",
  '{"thought":"...","action":{"type":"read","path":"relative/path"}}',
  '{"thought":"...","action":{"type":"write","path":"relative/path","content":"full file content"}}',
  '{"thought":"...","action":{"type":"run","command":"npm test"}}',
  '{"thought":"...","action":{"type":"done","summary":"..."}}',
  "Use only relative paths inside the workspace. Fix the failing test, run npm test, then done.",
].join("\n");

let summary = "";
let steps = 0;
for (; steps < 12; steps += 1) {
  const text = await gateway.generateText({
    system,
    prompt: transcript,
    model: { providerID: provider, id: modelId },
    timeoutMs: 90_000,
  });
  const parsed = parseAction(text);
  const action = parsed.action;
  if (!action || typeof action.type !== "string") {
    transcript += `\n\nAssistant: ${text.slice(0, 1200)}\nObservation: invalid action JSON. Reply with one action object only.`;
    continue;
  }
  if (action.type === "read") {
    const content = await readFile(inside(String(action.path)), "utf8");
    transcript += `\n\nAssistant action: read ${action.path}\nObservation:\n${content.slice(0, 12_000)}`;
  } else if (action.type === "write") {
    const target = inside(String(action.path));
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, String(action.content ?? ""));
    transcript += `\n\nAssistant action: write ${action.path}\nObservation: written`;
  } else if (action.type === "run") {
    const command = String(action.command ?? "");
    if (!/^npm test$/.test(command.trim())) {
      transcript += `\n\nAssistant action: run ${command}\nObservation: only "npm test" is allowed in this smoke test.`;
      continue;
    }
    const result = run(command);
    transcript += `\n\nAssistant action: run ${command}\nObservation: exit ${result.code}\n${result.output.slice(-8000)}`;
  } else if (action.type === "done") {
    summary = String(action.summary ?? "");
    break;
  } else {
    transcript += `\n\nAssistant action: ${JSON.stringify(action)}\nObservation: unknown action type.`;
  }
}

const final = run("npm test");
console.log(
  JSON.stringify(
    {
      gateway: gateway.name,
      root,
      steps: steps + 1,
      summary,
      passed: final.code === 0,
      finalOutput: final.output.slice(-1500),
    },
    null,
    2,
  ),
);
if (final.code !== 0) process.exitCode = 1;
await rm(root, { recursive: true, force: true });
