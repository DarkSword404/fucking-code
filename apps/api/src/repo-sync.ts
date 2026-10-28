import { eq } from "drizzle-orm";
import { getDb, projects } from "@devteam/db";
import { git, gitWithEnv } from "@devteam/workspace";

export interface RepoSyncResult {
  pushed: boolean;
  skipped: boolean;
  commit: string | null;
  branch: string;
  remote: string | null;
  error?: string;
}

function pushEnv(remote: string): Record<string, string> {
  const token = process.env.GIT_PUSH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!token || !/^https?:\/\//i.test(remote)) return {};
  let url: URL;
  try {
    url = new URL(remote);
  } catch {
    return {};
  }
  const host = url.hostname.toLowerCase();
  const username =
    process.env.GIT_PUSH_USERNAME ??
    (host.includes("github.com") ? "x-access-token" : "oauth2");
  const header = `Authorization: Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`;
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${url.origin}/.extraheader`,
    GIT_CONFIG_VALUE_0: header,
  };
}

/**
 * Push the project's base branch to its configured remote.
 *
 * This is intentionally separate from task branch pushes: the remote holds the
 * merged main branch, so another server can clone it and deploy immediately.
 */
export async function syncProjectRepo(projectId: string): Promise<RepoSyncResult> {
  const db = getDb();
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) throw new Error("project not found");
  const branch = project.defaultBranch || "main";
  if (!project.repoPath || !project.repoUrl) {
    return {
      pushed: false,
      skipped: true,
      commit: null,
      branch,
      remote: project.repoUrl ?? null,
    };
  }

  try {
    const dirty = await git(project.repoPath, [
      "status",
      "--porcelain",
      "--untracked-files=no",
    ]);
    if (dirty.trim()) {
      throw new Error("base repository has uncommitted changes; merge or commit them first");
    }
    const commit = (
      await git(project.repoPath, ["rev-parse", `refs/heads/${branch}`])
    ).trim();
    await gitWithEnv(
      project.repoPath,
      ["push", "--follow-tags", project.repoUrl, `${branch}:${branch}`],
      pushEnv(project.repoUrl),
      120_000,
    );
    await db
      .update(projects)
      .set({
        repoSyncStatus: "synced",
        repoSyncError: null,
        repoSyncedAt: new Date(),
        repoSyncedCommit: commit,
        updatedAt: new Date(),
      })
      .where(eq(projects.id, project.id));
    return {
      pushed: true,
      skipped: false,
      commit,
      branch,
      remote: project.repoUrl,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .update(projects)
      .set({
        repoSyncStatus: "failed",
        repoSyncError: message.slice(0, 2000),
        updatedAt: new Date(),
      })
      .where(eq(projects.id, project.id));
    return {
      pushed: false,
      skipped: false,
      commit: null,
      branch,
      remote: project.repoUrl,
      error: message.slice(0, 2000),
    };
  }
}
