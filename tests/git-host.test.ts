import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";
import { ensureHostedRepo, handleGitHttp } from "../apps/api/src/git-host.js";

const roots: string[] = [];
const originalRoot = process.env.PROJECT_GIT_ROOT;

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  if (originalRoot === undefined) delete process.env.PROJECT_GIT_ROOT;
  else process.env.PROJECT_GIT_ROOT = originalRoot;
});

async function repo(): Promise<{ root: string; projectId: string }> {
  const root = await mkdtemp(join(tmpdir(), "fc-git-host-"));
  roots.push(root);
  const projectId = "01900000-0000-7000-8000-0000000000aa";
  process.env.PROJECT_GIT_ROOT = join(root, "mirrors");
  await writeFile(join(root, "README.md"), "# hosted\n");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-qm", "init"],
    { cwd: root },
  );
  return { root, projectId };
}

describe("git hosting", () => {
  test("creates a bare mirror and serves upload-pack discovery", async () => {
    const { root, projectId } = await repo();
    const bare = await ensureHostedRepo(projectId, root);
    expect(bare).toContain(`${projectId}.git`);

    const response = await handleGitHttp({
      projectId,
      repoPath: root,
      pathInfo: "info/refs",
      method: "GET",
      query: "service=git-upload-pack",
      headers: { "git-protocol": "version=2" },
      body: Buffer.alloc(0),
      remoteUser: "test@example.com",
    });

    expect(response.status).toBe(200);
    expect(response.body.toString("utf8")).toContain("version 2");
  });

  test("rejects receive-pack so pushes cannot bypass review", async () => {
    const { root, projectId } = await repo();
    const response = await handleGitHttp({
      projectId,
      repoPath: root,
      pathInfo: "git-receive-pack",
      method: "POST",
      query: "",
      headers: { "content-type": "application/x-git-receive-pack-request" },
      body: Buffer.alloc(0),
      remoteUser: "test@example.com",
    });

    expect(response.status).toBe(403);
    expect(response.body.toString("utf8")).toContain("push is disabled");
  });
});
