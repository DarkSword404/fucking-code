import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";
import { isDependencyInstallCommand, runBuiltinAgent } from "@devteam/workspace";
import type { ModelGateway } from "@devteam/agents";

class ScriptedGateway implements ModelGateway {
  readonly name = "scripted";
  constructor(private readonly responses: string[]) {}
  private index = 0;
  async generateText(): Promise<string> {
    const value = this.responses[this.index] ?? '{"action":{"type":"done","summary":"done"}}';
    this.index += 1;
    return value;
  }
}

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("builtin code agent", () => {
  test("fixes a failing test without an OpenCode session", async () => {
    const root = await mkdtemp(join(tmpdir(), "fc-builtin-test-"));
    roots.push(root);
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "test"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "builtin-test", type: "module", scripts: { test: "node --test" } }),
    );
    await writeFile(join(root, "src/add.js"), "export const add = (a, b) => a - b;\n");
    await writeFile(
      join(root, "test/add.test.js"),
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/add.js';\ntest('add', () => assert.equal(add(2, 3), 5));\n",
    );
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-qm", "init"],
      { cwd: root },
    );

    const gateway = new ScriptedGateway([
      JSON.stringify({
        thought: "fix the operator",
        action: { type: "write", path: "src/add.js", content: "export const add = (a, b) => a + b;\n" },
      }),
      JSON.stringify({ thought: "verify", action: { type: "run", command: "npm test" } }),
      JSON.stringify({ thought: "done", action: { type: "done", summary: "fixed add" } }),
    ]);

    const result = await runBuiltinAgent({
      root,
      taskTitle: "fix add",
      taskDescription: "add should add",
      acceptance: ["npm test passes"],
      specText: "add(2,3) must be 5",
      model: { providerID: "test", id: "test" },
      gateway,
      maxSteps: 5,
      timeoutMs: 30_000,
    });

    expect(result.outcome).toBe("succeeded");
    expect(result.toolCalls).toBe(3);
    expect(result.summary).toContain("fixed add");
    expect(() => execFileSync("npm", ["test"], { cwd: root, stdio: "ignore" })).not.toThrow();
  });
});

describe("builtin edit action", () => {
  test("replaces one exact snippet without rewriting the file", async () => {
    const root = await mkdtemp(join(tmpdir(), "fc-builtin-edit-"));
    roots.push(root);
    const before = `${"line before\n".repeat(50)}const answer = 1;\n${"line after\n".repeat(50)}`;
    await writeFile(join(root, "app.js"), before);
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-qm", "init"],
      { cwd: root },
    );

    const gateway = new ScriptedGateway([
      JSON.stringify({
        thought: "targeted change",
        action: { type: "edit", path: "app.js", old: "const answer = 1;", new: "const answer = 42;" },
      }),
      JSON.stringify({ thought: "done", action: { type: "done", summary: "edited answer" } }),
    ]);

    const result = await runBuiltinAgent({
      root,
      taskTitle: "edit answer",
      taskDescription: "answer should be 42",
      acceptance: ["answer is 42"],
      specText: "",
      model: { providerID: "test", id: "test" },
      gateway,
      maxSteps: 3,
      timeoutMs: 30_000,
    });

    expect(result.outcome).toBe("succeeded");
    const { readFile } = await import("node:fs/promises");
    const after = await readFile(join(root, "app.js"), "utf8");
    expect(after).toContain("const answer = 42;");
    expect(after.split("\n").length).toBe(before.split("\n").length);
  });

  test("rejects an ambiguous edit target", async () => {
    const root = await mkdtemp(join(tmpdir(), "fc-builtin-edit-"));
    roots.push(root);
    await writeFile(join(root, "dup.txt"), "same\nsame\n");

    const gateway = new ScriptedGateway([
      JSON.stringify({
        action: { type: "edit", path: "dup.txt", old: "same", new: "different" },
      }),
      JSON.stringify({ action: { type: "done", summary: "gave up" } }),
    ]);

    const result = await runBuiltinAgent({
      root,
      taskTitle: "ambiguous edit",
      taskDescription: "must not guess",
      acceptance: ["no blind edit"],
      specText: "",
      model: { providerID: "test", id: "test" },
      gateway,
      maxSteps: 3,
      timeoutMs: 30_000,
    });

    const { readFile } = await import("node:fs/promises");
    expect(await readFile(join(root, "dup.txt"), "utf8")).toBe("same\nsame\n");
    expect(result.toolCalls).toBeGreaterThan(0);
  });
});

describe("builtin JSON repair", () => {
  test("executes a write whose content contains raw newlines", async () => {
    const root = await mkdtemp(join(tmpdir(), "fc-builtin-raw-"));
    roots.push(root);

    const gateway = new ScriptedGateway([
      `{"thought":"write","action":{"type":"write","path":"big.txt","content":"line1
line2
line3"}}`,
      JSON.stringify({ action: { type: "done", summary: "wrote raw" } }),
    ]);

    const result = await runBuiltinAgent({
      root,
      taskTitle: "raw write",
      taskDescription: "write multiline content",
      acceptance: ["big.txt exists"],
      specText: "",
      model: { providerID: "test", id: "test" },
      gateway,
      maxSteps: 3,
      timeoutMs: 30_000,
    });

    expect(result.outcome).toBe("succeeded");
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(join(root, "big.txt"), "utf8")).toBe("line1\nline2\nline3");
  });
});

describe("builtin model retry", () => {
  test("retries one transient timeout when the task budget allows it", async () => {
    const root = await mkdtemp(join(tmpdir(), "fc-builtin-retry-"));
    roots.push(root);
    await writeFile(join(root, "note.txt"), "ok\n");

    class FlakyGateway implements ModelGateway {
      readonly name = "flaky";
      calls = 0;
      async generateText(): Promise<string> {
        this.calls += 1;
        if (this.calls === 1) throw new Error("The operation was aborted due to timeout");
        return JSON.stringify({ action: { type: "done", summary: "recovered" } });
      }
    }
    const gateway = new FlakyGateway();

    const result = await runBuiltinAgent({
      root,
      taskTitle: "retry",
      taskDescription: "survive one timeout",
      acceptance: ["done"],
      specText: "",
      model: { providerID: "test", id: "test" },
      gateway,
      maxSteps: 2,
      timeoutMs: 30_000,
    });

    expect(result.outcome).toBe("succeeded");
    expect(gateway.calls).toBe(2);
    expect(result.summary).toContain("recovered");
  });
});

describe("dependency install guard", () => {
  test("refuses installers inside the shared worktree", () => {
    expect(isDependencyInstallCommand("npm ci")).toBe(true);
    expect(isDependencyInstallCommand("npm install --no-audit")).toBe(true);
    expect(isDependencyInstallCommand("pnpm i")).toBe(true);
    expect(isDependencyInstallCommand("yarn install --frozen-lockfile")).toBe(true);
    expect(isDependencyInstallCommand("cd /workspace && npm ci --no-audit")).toBe(true);
    expect(isDependencyInstallCommand("npm --prefix . ci")).toBe(true);
    expect(isDependencyInstallCommand("yarn")).toBe(true);
    expect(isDependencyInstallCommand("npm test")).toBe(false);
    expect(isDependencyInstallCommand("node --test")).toBe(false);
    expect(isDependencyInstallCommand("npm run build")).toBe(false);
    expect(isDependencyInstallCommand("npm run install-fixtures")).toBe(false);
  });
});
