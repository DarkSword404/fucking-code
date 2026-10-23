import { rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createWorkspace,
  ensureDemoRepo,
  readWorkspaceFile,
  runCommand,
  workspaceDiff,
} from "@devteam/workspace";

let root = "";
let repoPath = "";
let workspacePath = "";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "devteam-ws-"));
  process.env.ALLOWED_REPO_ROOTS = join(root, "repos");
  process.env.WORKSPACE_ROOT = join(root, "worktrees");
  repoPath = await ensureDemoRepo(join(root, "repos"));
  const workspace = await createWorkspace({
    repoPath,
    projectId: "project-1",
    taskId: "task-12345678",
  });
  workspacePath = workspace.path;
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("workspace manager", () => {
  test("creates an isolated worktree with a branch", async () => {
    const content = await readWorkspaceFile(workspacePath, "src/notes.js");
    expect(content).toContain("class NoteStore");
  });

  test("blocks path traversal and symlink escapes", async () => {
    await expect(readWorkspaceFile(workspacePath, "../outside.txt")).rejects.toThrow(
      /escapes the workspace/,
    );
  });

  test("captures a diff after a change", async () => {
    await writeFile(join(workspacePath, "src/notes.js"), "export const changed = true;\n", "utf8");
    const diff = await workspaceDiff(workspacePath);
    expect(diff).toContain("src/notes.js");
    expect(diff).toContain("changed");
  });

  test("rejects dangerous commands", async () => {
    const result = await runCommand(workspacePath, "rm -rf /", 5000);
    expect(result.status).toBe("error");
    expect(result.output).toMatch(/not allowed|metacharacters/i);
  });

  test("runs an allowed command in the workspace", async () => {
    const result = await runCommand(workspacePath, "node --version", 10_000);
    expect(result.status).toBe("passed");
    expect(result.output).toMatch(/^v\d+/);
  });
});
