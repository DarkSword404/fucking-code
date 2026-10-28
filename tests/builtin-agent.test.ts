import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";
import { runBuiltinAgent } from "@devteam/workspace";
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
