import { execFile, spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

function repoRoot(): string {
  return resolve(process.env.PROJECT_GIT_ROOT ?? "./data/git");
}

function barePath(projectId: string): string {
  if (!/^[0-9a-f-]{20,40}$/i.test(projectId)) throw new Error("invalid project id");
  return join(repoRoot(), `${projectId}.git`);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout.trim();
}

/**
 * Keep a bare, read-only mirror for each project. The worktree flow keeps
 * writing to the normal repository; this mirror is only for `git clone/fetch`
 * by another machine.
 */
export async function ensureHostedRepo(projectId: string, repoPath: string): Promise<string> {
  const bare = barePath(projectId);
  await mkdir(repoRoot(), { recursive: true });
  if (!existsSync(bare)) {
    await execFileAsync("git", ["clone", "--bare", "--no-hardlinks", repoPath, bare], {
      timeout: 120_000,
      maxBuffer: 20 * 1024 * 1024,
    });
  } else {
    await git(bare, [
      "fetch",
      "--prune",
      repoPath,
      "+refs/heads/*:refs/heads/*",
      "+refs/tags/*:refs/tags/*",
    ]);
  }
  try {
    const branch = await git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (branch && branch !== "HEAD") {
      await git(bare, ["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
    }
  } catch {
    // An empty source repository is still a valid hosted repo.
  }
  await git(bare, ["config", "http.receivepack", "false"]).catch(() => undefined);
  return bare;
}

function parseCgiResponse(raw: Buffer): GitHttpResponse {
  let headerEnd = raw.indexOf("\r\n\r\n");
  let separator = 4;
  if (headerEnd < 0) {
    headerEnd = raw.indexOf("\n\n");
    separator = 2;
  }
  if (headerEnd < 0) {
    return {
      status: 502,
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: Buffer.from("git http-backend returned no headers"),
    };
  }
  const headerText = raw.subarray(0, headerEnd).toString("utf8");
  const body = raw.subarray(headerEnd + separator);
  let status = 200;
  const headers: Record<string, string> = {};
  for (const line of headerText.split(/\r?\n/)) {
    const index = line.indexOf(":");
    if (index <= 0) continue;
    const name = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    if (name === "status") {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) status = parsed;
      continue;
    }
    if (name === "content-length") continue;
    headers[name] = value;
  }
  return { status, headers, body };
}

/**
 * Run `git http-backend` for one request. Only fetch/clone is served; receive
 * pack is disabled so external clients cannot bypass the task/review flow.
 */
export async function handleGitHttp(input: {
  projectId: string;
  repoPath: string;
  pathInfo: string;
  method: string;
  query: string;
  headers: Record<string, string | undefined>;
  body: Buffer;
  remoteUser: string;
}): Promise<GitHttpResponse> {
  if (!["GET", "POST"].includes(input.method)) {
    return {
      status: 405,
      headers: { "content-type": "text/plain; charset=utf-8", allow: "GET, POST" },
      body: Buffer.from("method not allowed"),
    };
  }
  if (input.pathInfo.includes("git-receive-pack")) {
    return {
      status: 403,
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: Buffer.from(
        "push is disabled on the hosted mirror; use the normal task/review flow",
      ),
    };
  }

  const bare = await ensureHostedRepo(input.projectId, input.repoPath);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_PROJECT_ROOT: repoRoot(),
    GIT_HTTP_EXPORT_ALL: "1",
    PATH_INFO: `/${input.projectId}.git/${input.pathInfo}`.replace(/\/+$/, ""),
    REQUEST_METHOD: input.method,
    QUERY_STRING: input.query,
    REMOTE_USER: input.remoteUser,
    CONTENT_TYPE: input.headers["content-type"] ?? "",
    CONTENT_LENGTH: String(input.body.length),
    SERVER_PROTOCOL: "HTTP/1.1",
    GATEWAY_INTERFACE: "CGI/1.1",
    HTTP_GIT_PROTOCOL: input.headers["git-protocol"] ?? "",
  };

  return new Promise<GitHttpResponse>((resolvePromise, reject) => {
    const child = spawn("git", ["http-backend"], {
      cwd: bare,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    child.on("error", reject);
    child.on("close", () => {
      if (chunks.length) {
        resolvePromise(parseCgiResponse(Buffer.concat(chunks)));
        return;
      }
      resolvePromise({
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8" },
        body: Buffer.from(
          `git http-backend failed: ${Buffer.concat(errors).toString("utf8").slice(0, 2000)}`,
        ),
      });
    });
    child.stdin.end(input.body);
  });
}
