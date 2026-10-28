import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { defaultRunnerImage, dockerRunCommand } from "@devteam/workspace";

const roots: string[] = [];
const originalImage = process.env.RUNNER_IMAGE;
const originalMode = process.env.RUNNER_MODE;

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  if (originalImage === undefined) delete process.env.RUNNER_IMAGE;
  else process.env.RUNNER_IMAGE = originalImage;
  if (originalMode === undefined) delete process.env.RUNNER_MODE;
  else process.env.RUNNER_MODE = originalMode;
});

async function scratch(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "fc-runner-test-"));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(root, name), content);
  }
  return root;
}

describe("docker runner", () => {
  test("picks node for a Node project", async () => {
    delete process.env.RUNNER_IMAGE;
    const root = await scratch({ "package.json": "{}" });
    expect(defaultRunnerImage(root)).toBe("node:22-bookworm-slim");
  });

  test("picks python for a Python project", async () => {
    delete process.env.RUNNER_IMAGE;
    const root = await scratch({ "requirements.txt": "pytest==8.0.0\n" });
    expect(defaultRunnerImage(root)).toBe("python:3.12-slim");
  });

  test("honours RUNNER_IMAGE override", async () => {
    process.env.RUNNER_IMAGE = "registry.example/dev/runner:1";
    const root = await scratch({ "package.json": "{}" });
    expect(defaultRunnerImage(root)).toBe("registry.example/dev/runner:1");
  });

  test("refuses to run when the runner mode is not docker", async () => {
    process.env.RUNNER_MODE = "host";
    const root = await scratch({ "package.json": "{}" });
    const result = await dockerRunCommand({
      root,
      command: "npm test",
      bin: "npm",
      args: ["test"],
      timeoutMs: 1_000,
      network: false,
    });
    expect(result.status).toBe("error");
    expect(result.output).toContain("RUNNER_MODE is not docker");
  });
});
