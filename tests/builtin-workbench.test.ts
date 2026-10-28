import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { runBuiltinAgent } from "@devteam/workspace";
import type { ModelGateway } from "@devteam/agents";

class ScriptedGateway implements ModelGateway {
  readonly name = "scripted";
  constructor(private readonly responses: string[]) {}
  private index = 0;
  async generateText(): Promise<string> {
    const value =
      this.responses[this.index] ?? '{"action":{"type":"done","summary":"done"}}';
    this.index += 1;
    return value;
  }
}

const roots: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "fc-workbench-test-"));
  roots.push(root);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "workbench-test", type: "module", scripts: { test: "node --test" } }),
  );
  return root;
}

async function serve(html: string): Promise<number> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(html);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (typeof address !== "object" || !address) throw new Error("no server address");
  return address.port;
}

describe("builtin workbench agent", () => {
  test("fetches a page and writes evidence without code changes", async () => {
    const root = await scratch();
    const port = await serve("<html><title>Scratch QA</title><h1>ok</h1></html>");
    const gateway = new ScriptedGateway([
      JSON.stringify({
        thought: "fetch the preview",
        action: { type: "fetch", url: `http://127.0.0.1:${port}/` },
      }),
      JSON.stringify({
        thought: "record evidence",
        action: {
          type: "write",
          path: "docs/qa-evidence/report.md",
          content: "# QA\n\nHTTP 200, title present.\n",
        },
      }),
      JSON.stringify({
        thought: "finish",
        action: { type: "done", summary: "首页返回 200，标题正确。" },
      }),
    ]);

    const result = await runBuiltinAgent({
      root,
      taskTitle: "QA walkthrough",
      taskDescription: "Verify the page",
      acceptance: ["HTTP 200", "title present"],
      specText: "",
      model: { providerID: "test", id: "test" },
      gateway,
      mode: "workbench",
      maxSteps: 6,
      timeoutMs: 30_000,
    });

    expect(result.outcome).toBe("succeeded");
    expect(result.transcript).toContain("HTTP 200");
    expect(result.transcript).toContain("Scratch QA");
    expect(result.toolCalls).toBe(3);
    const report = await readFile(join(root, "docs/qa-evidence/report.md"), "utf8");
    expect(report).toContain("HTTP 200");
  });

  test("refuses to modify product code in workbench mode", async () => {
    const root = await scratch();
    const gateway = new ScriptedGateway([
      JSON.stringify({
        thought: "try to edit code",
        action: { type: "write", path: "src/hack.js", content: "export const hacked = true;\n" },
      }),
      JSON.stringify({
        thought: "finish",
        action: { type: "done", summary: "done" },
      }),
    ]);

    const result = await runBuiltinAgent({
      root,
      taskTitle: "QA guard",
      taskDescription: "Do not edit product code",
      acceptance: ["no code changes"],
      specText: "",
      model: { providerID: "test", id: "test" },
      gateway,
      mode: "workbench",
      maxSteps: 4,
      timeoutMs: 30_000,
    });

    expect(result.outcome).toBe("succeeded");
    expect(result.transcript).toContain("workbench may only write evidence");
    await expect(readFile(join(root, "src/hack.js"), "utf8")).rejects.toThrow();
  });
});
