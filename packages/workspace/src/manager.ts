import { execFile, spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { git, gitSafe, gitWithEnv } from "./git.js";

export interface WorkspaceInfo {
  path: string;
  branch: string;
  baseCommit: string;
}

export interface FileEntry {
  path: string;
  status: string;
}

export type CommandStatus = "passed" | "failed" | "timeout" | "error";

export interface CommandResult {
  command: string;
  exitCode: number | null;
  status: CommandStatus;
  output: string;
  durationMs: number;
}

const ALLOWED_COMMANDS = new Set([
  "npm",
  "npx",
  "node",
  "git",
  "pnpm",
  "bun",
  "yarn",
  "python",
  "python3",
  "pytest",
  "uv",
  "poetry",
]);
const SAFE_GIT_COMMANDS = new Set([
  "status",
  "diff",
  "log",
  "show",
  "branch",
  "rev-parse",
  "ls-files",
]);
const MAX_OUTPUT = 200_000;

function workspaceRoot(): string {
  return resolve(process.env.WORKSPACE_ROOT ?? "./data/worktrees");
}

function allowedRepoRoots(): string[] {
  const raw = process.env.ALLOWED_REPO_ROOTS ?? "./data/repos";
  return raw.split(":").map((p) => resolve(p));
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function safeRepoPath(repoPath: string): Promise<string> {
  const absolute = resolve(repoPath);
  let real: string;
  try {
    real = await realpath(absolute);
  } catch {
    throw new Error(`repository path does not exist: ${absolute}`);
  }
  const info = await stat(real);
  if (!info.isDirectory()) throw new Error(`repository path is not a directory: ${absolute}`);
  const roots = allowedRepoRoots();
  if (!roots.some((root) => isInside(root, real))) {
    throw new Error(`repository path is outside ALLOWED_REPO_ROOTS: ${absolute}`);
  }
  return real;
}

/** Validate a project repo path before saving it. */
export async function validateRepoPath(repoPath: string): Promise<void> {
  const repo = await safeRepoPath(repoPath);
  try {
    await git(repo, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    throw new Error(`repository path is not a Git work tree: ${repo}`);
  }
}

export async function safeWorkspacePath(root: string, relPath: string): Promise<string> {
  const target = resolve(root, relPath);
  if (!isInside(root, target)) throw new Error("path escapes the workspace");
  const real = await realpath(target).catch(() => target);
  if (!isInside(root, real)) throw new Error("symlink escapes the workspace");
  return real;
}

const dependencyBootstraps = new Map<string, Promise<void>>();

/**
 * A worktree shares the base repository's `node_modules` through a symlink, so
 * the base repository must have a usable dependency tree before any task runs.
 * A dangling or self-referential link would otherwise make every `npm test`
 * fail with ERR_MODULE_NOT_FOUND, which used to surface as an unexplained task
 * failure. Install once per repository when dependencies are missing.
 */
async function ensureBaseDependencies(repo: string): Promise<void> {
  const running = dependencyBootstraps.get(repo);
  if (running) return running;
  const job = (async () => {
    try {
      await readFile(join(repo, "package.json"), "utf8");
    } catch {
      return; // not a Node project
    }

    const modules = join(repo, "node_modules");
    try {
      const info = await lstat(modules);
      if (info.isSymbolicLink()) {
        const link = await readlink(modules).catch(() => "");
        const target = link ? resolve(dirname(modules), link) : "";
        // A link that points at itself is an infinite loop and cannot be used.
        if (!target || target === modules) await rm(modules, { force: true });
      }
    } catch {
      // no node_modules yet
    }

    try {
      const info = await stat(modules);
      if (info.isDirectory() && (await readdir(modules)).length > 0) return;
    } catch {
      // missing or dangling
    }

    await rm(modules, { recursive: true, force: true });
    const hasLock = await stat(join(repo, "package-lock.json"))
      .then(() => true)
      .catch(() => false);
    const args = hasLock
      ? ["ci", "--no-audit", "--no-fund"]
      : ["install", "--no-audit", "--no-fund"];
    await new Promise<void>((done) => {
      execFile(
        "npm",
        args,
        { cwd: repo, timeout: 300_000, env: { ...process.env, CI: "1" } },
        (error, stdout, stderr) => {
          if (error) {
            console.error("[workspace] dependency install failed", {
              repo,
              error: error.message,
              output: `${stdout}\n${stderr}`.slice(-800),
            });
          }
          done();
        },
      );
    });
  })().finally(() => {
    dependencyBootstraps.delete(repo);
  });
  dependencyBootstraps.set(repo, job);
  return job;
}

export async function createWorkspace(input: {
  repoPath: string;
  projectId: string;
  taskId: string;
}): Promise<WorkspaceInfo> {
  const repo = await safeRepoPath(input.repoPath);
  await ensureBaseDependencies(repo);
  const baseCommit = (await git(repo, ["rev-parse", "HEAD"])).trim();
  const suffix = Date.now().toString(36).slice(-5);
  const branch = `devteam/${input.taskId.slice(0, 8)}-${suffix}`;
  const dest = resolve(workspaceRoot(), input.projectId, `${input.taskId}-${suffix}`);

  await mkdir(dirname(dest), { recursive: true });
  await rm(dest, { recursive: true, force: true });
  await git(repo, ["worktree", "add", "-b", branch, dest, baseCommit]);
  // Ignored dependency directories are not copied by `git worktree add`.
  // Link them from the base repository so Python/Node projects can actually
  // run their tests in the isolated worktree.
  for (const dep of [".venv", "node_modules"]) {
    const source = join(repo, dep);
    const target = join(dest, dep);
    try {
      const info = await lstat(source);
      const linkSource = info.isSymbolicLink() ? await realpath(source) : source;
      if (linkSource === target) continue;
      await symlink(linkSource, target, "dir");
    } catch {
      // dependency directory does not exist or is already tracked
    }
  }
  return { path: dest, branch, baseCommit };
}

export async function removeWorkspace(
  repoPath: string,
  workspacePath: string,
  branch?: string,
): Promise<void> {
  await gitSafe(repoPath, ["worktree", "remove", "--force", workspacePath]);
  if (branch) await gitSafe(repoPath, ["branch", "-D", branch]);
  await rm(workspacePath, { recursive: true, force: true });
}

export interface PushWorkspaceInput {
  repoPath: string;
  workspacePath: string;
  branch: string;
  remoteUrl?: string | null;
  message: string;
  authorName: string;
  authorEmail: string;
}

/** Commit the worktree and push its branch to origin (without merging). */
export async function pushWorkspaceBranch(
  input: PushWorkspaceInput,
): Promise<{ commit: string; remote: string; branch: string }> {
  const repo = await safeRepoPath(input.repoPath);
  const workspace = resolve(input.workspacePath);
  if (!isInside(workspaceRoot(), workspace)) {
    throw new Error("workspace path is outside the workspace root");
  }
  const currentBranch = (await git(workspace, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  if (currentBranch !== input.branch) {
    throw new Error(`workspace is on ${currentBranch}, expected ${input.branch}`);
  }
  await git(workspace, ["add", "-A"]);
  await git(workspace, ["rm", "-r", "--cached", "--ignore-unmatch", "--quiet", "node_modules", ".venv"]).catch(
    () => undefined,
  );
  if ((await git(workspace, ["status", "--porcelain", "--untracked-files=no"])).trim()) {
    await git(workspace, [
      "-c",
      `user.name=${input.authorName}`,
      "-c",
      `user.email=${input.authorEmail}`,
      "commit",
      "-m",
      input.message,
    ]);
  }

  let remote = (await gitSafe(repo, ["remote", "get-url", "origin"])).trim();
  if (!remote && input.remoteUrl) {
    await git(repo, ["remote", "add", "origin", input.remoteUrl]);
    remote = input.remoteUrl;
  }
  if (!remote) throw new Error("repository has no origin remote and no repoUrl configured");
  const token = process.env.GITHUB_TOKEN;
  const isGitHub = /github\.com/i.test(remote);
  if (token && isGitHub) {
    const header = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
    await gitWithEnv(repo, ["push", "origin", input.branch], {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: header,
    });
  } else {
    await git(repo, ["push", "origin", input.branch]);
  }
  const commit = (await git(workspace, ["rev-parse", "HEAD"])).trim();
  return { commit, remote, branch: input.branch };
}

export interface MergeWorkspaceInput {
  repoPath: string;
  workspacePath: string;
  branch: string;
  baseBranch: string;
  message: string;
  authorName: string;
  authorEmail: string;
}

/** Commit the worktree and merge its branch into the project's base branch. */
export async function commitAndMergeWorkspace(
  input: MergeWorkspaceInput,
): Promise<{ commit: string; branch: string; baseBranch: string }> {
  const repo = await safeRepoPath(input.repoPath);
  const workspace = resolve(input.workspacePath);
  if (!isInside(workspaceRoot(), workspace)) {
    throw new Error("workspace path is outside the workspace root");
  }
  const currentBranch = (await git(workspace, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  if (currentBranch !== input.branch) {
    throw new Error(`workspace is on ${currentBranch}, expected ${input.branch}`);
  }

  await git(workspace, ["add", "-A"]);
  // Dependency directories are linked from the base repo and must never be
  // committed. Older repos may still track a node_modules symlink; drop it from
  // the index so a task cannot re-introduce a self-referential link.
  await git(workspace, ["rm", "-r", "--cached", "--ignore-unmatch", "--quiet", "node_modules", ".venv"]).catch(
    () => undefined,
  );
  const workspaceStatus = await git(workspace, ["status", "--porcelain", "--untracked-files=no"]);
  if (workspaceStatus.trim()) {
    await git(workspace, [
      "-c",
      `user.name=${input.authorName}`,
      "-c",
      `user.email=${input.authorEmail}`,
      "commit",
      "-m",
      input.message,
    ]);
  }

  const baseStatus = await git(repo, ["status", "--porcelain"]);
  if (baseStatus.trim()) {
    throw new Error("the base repository has uncommitted changes; clean it before merging");
  }
  let baseBranch = input.baseBranch;
  try {
    await git(repo, ["rev-parse", "--verify", baseBranch]);
  } catch {
    baseBranch = (await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    if (!baseBranch || baseBranch === "HEAD") {
      throw new Error(`base branch ${input.baseBranch} does not exist`);
    }
  }
  const repoBranch = (await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  if (repoBranch !== baseBranch) {
    await git(repo, ["checkout", baseBranch]);
  }

  try {
    await git(repo, [
      "-c",
      `user.name=${input.authorName}`,
      "-c",
      `user.email=${input.authorEmail}`,
      "merge",
      "--no-ff",
      input.branch,
      "-m",
      `Merge ${input.branch}: ${input.message}`,
    ]);
  } catch (error) {
    await gitSafe(repo, ["merge", "--abort"]);
    throw error;
  }

  const commit = (await git(repo, ["rev-parse", "HEAD"])).trim();
  return { commit, branch: input.branch, baseBranch };
}

/** Remove the per-project workspace directory after all task worktrees are gone. */
export async function removeProjectWorkspaceDirectory(projectId: string): Promise<void> {
  await removeWorkspaceDirectory(resolve(workspaceRoot(), projectId));
}

/** Remove a workspace directory without a base repo (validated to stay under WORKSPACE_ROOT). */
export async function removeWorkspaceDirectory(workspacePath: string): Promise<void> {
  const root = workspaceRoot();
  const target = resolve(workspacePath);
  if (!isInside(root, target)) {
    throw new Error("workspace path is outside the workspace root");
  }
  await rm(target, { recursive: true, force: true });
}

export async function writeWorkspaceFile(
  root: string,
  relPath: string,
  content: string,
): Promise<void> {
  const target = await safeWorkspacePath(root, relPath);
  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  const rootReal = await realpath(root);
  const parentReal = await realpath(parent);
  if (!isInside(rootReal, parentReal)) {
    throw new Error("file path escapes the workspace");
  }
  await writeFile(target, content, "utf8");
}

export async function listFiles(root: string): Promise<FileEntry[]> {
  const tracked = await gitSafe(root, [
    "-c",
    "core.quotepath=false",
    "ls-files",
    "-co",
    "--exclude-standard",
    "-z",
  ]);
  const status = await gitSafe(root, [
    "-c",
    "core.quotepath=false",
    "status",
    "--porcelain",
    "-z",
  ]);
  const statusMap = new Map<string, string>();
  for (const line of status.split("\0").filter(Boolean)) {
    const code = line.slice(0, 2).trim();
    const path = line.slice(3);
    if (path) statusMap.set(path, code || "M");
  }
  return tracked
    .split("\0")
    .filter(Boolean)
    .sort()
    .map((path) => ({ path, status: statusMap.get(path) ?? "tracked" }));
}

export async function readWorkspaceFile(root: string, relPath: string): Promise<string> {
  const target = await safeWorkspacePath(root, relPath);
  const info = await stat(target);
  if (!info.isFile()) throw new Error("not a file");
  if (info.size > 1_000_000) throw new Error("file is larger than 1MB");
  return readFile(target, "utf8");
}

/** Read-only access to the project's base repository (not a worktree). */
export async function listRepoFiles(repoPath: string): Promise<FileEntry[]> {
  const repo = await safeRepoPath(repoPath);
  return listFiles(repo);
}

export async function readRepoFile(repoPath: string, relPath: string): Promise<string> {
  const repo = await safeRepoPath(repoPath);
  return readWorkspaceFile(repo, relPath);
}

/**
 * Compact repository context for discussion agents, which do not have tools.
 * Keeps the tree, package metadata, README and the first few test files.
 */
export async function readRepoContext(repoPath: string): Promise<string> {
  const repo = await safeRepoPath(repoPath);
  const files = (await gitSafe(repo, ["-c", "core.quotepath=false", "ls-files", "-z"]))
    .split("\0")
    .filter(Boolean);
  const tree = files.slice(0, 80).join("\n");

  const read = async (rel: string): Promise<string> => {
    try {
      const target = await safeWorkspacePath(repo, rel);
      return await readFile(target, "utf8");
    } catch {
      return "";
    }
  };

  const pkg = await read("package.json");
  const readme = await read("README.md");
  const testFiles = files
    .filter((file) =>
      /(^|\/)(test|tests)\/.*\.(js|ts|mjs|mts)$/.test(file) ||
      /\.(test|spec)\.(js|ts|mjs|mts)$/.test(file),
    )
    .slice(0, 3);

  const tests: string[] = [];
  for (const file of testFiles) {
    const content = await read(file);
    if (content) tests.push(`### ${file}\n\`\`\`\n${content.slice(0, 6000)}\n\`\`\``);
  }

  return [
    `文件树（前 80 个）：\n${tree}`,
    pkg ? `### package.json\n\`\`\`json\n${pkg.slice(0, 3000)}\n\`\`\`` : "",
    readme ? `### README.md\n${readme.slice(0, 4000)}` : "",
    ...tests,
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 24_000);
}

/** Stage everything in the isolated worktree, then return a reviewable diff. */
export async function workspaceDiff(
  root: string,
  baseCommit?: string | null,
): Promise<string> {
  const base = baseCommit || "HEAD";
  await gitSafe(root, ["add", "-A"]);
  return gitSafe(root, [
    "-c",
    "core.quotepath=false",
    "diff",
    "--cached",
    "--no-color",
    base,
  ]);
}

/**
 * Name-status list relative to the worktree's base commit. This must not use
 * `git status`: coding agents may commit their work, after which status is
 * clean even though the branch contains reviewable changes.
 */
export async function workspaceChangedFiles(
  root: string,
  baseCommit?: string | null,
): Promise<FileEntry[]> {
  const base = baseCommit || "HEAD";
  const output = await gitSafe(root, [
    "-c",
    "core.quotepath=false",
    "diff",
    "--name-status",
    base,
  ]);
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t");
      const status = (parts[0] ?? "M").charAt(0);
      const path = parts[parts.length - 1] ?? "";
      return { path, status };
    })
    .filter((entry) => Boolean(entry.path))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export async function detectTestCommand(root: string): Promise<string | null> {
  try {
    const raw = await readFile(resolve(root, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    if (pkg.scripts?.test) return "npm test";
  } catch {
    // no package.json
  }
  const hasNodeTests = await stat(resolve(root, "test")).then(
    (s) => s.isDirectory(),
    () => false,
  );
  if (hasNodeTests) return "node --test";

  const hasPythonProject = await Promise.any([
    stat(resolve(root, "pytest.ini")).then(() => true),
    stat(resolve(root, "pyproject.toml")).then(() => true),
    stat(resolve(root, "tests")).then((s) => s.isDirectory()),
    stat(resolve(root, "test")).then((s) => s.isDirectory()),
  ]).catch(() => false);
  if (hasPythonProject) {
    const hasVenvPytest = await stat(resolve(root, ".venv/bin/pytest")).then(
      () => true,
      () => false,
    );
    return hasVenvPytest ? ".venv/bin/python -m pytest -q" : "python3 -m pytest -q";
  }
  return null;
}

async function sandboxArgs(root: string, bin: string, args: string[]): Promise<string[]> {
  const workspace = resolve(root);
  const out: string[] = [
    "--ro-bind",
    "/usr",
    "/usr",
    "--ro-bind",
    "/bin",
    "/bin",
    "--ro-bind",
    "/lib",
    "/lib",
    "--ro-bind",
    "/lib64",
    "/lib64",
    "--ro-bind",
    "/etc",
    "/etc",
    "--tmpfs",
    "/tmp",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
  ];
  const addDirs = (path: string) => {
    let current = "";
    for (const part of dirname(path).split("/").filter(Boolean)) {
      current += `/${part}`;
      out.push("--dir", current);
    }
  };
  addDirs(workspace);
  out.push(
    "--dir",
    workspace,
    "--bind",
    workspace,
    workspace,
  );
  // Dependency directories linked from the base repo (e.g. .venv) live
  // outside the workspace. Bind them read-only so tests can run without
  // copying hundreds of megabytes into every worktree.
  for (const dep of [".venv", "node_modules"]) {
    try {
      const source = await realpath(resolve(workspace, dep));
      if (!isInside(workspace, source)) {
        addDirs(source);
        out.push("--dir", source, "--ro-bind", source, source);
      }
    } catch {
      // no dependency directory
    }
  }
  out.push("--unshare-all", "--die-with-parent", "--chdir", workspace, "--", bin, ...args);
  return out;
}

export async function runCommand(
  root: string,
  command: string,
  timeoutMs = 120_000,
): Promise<CommandResult> {
  const started = Date.now();
  const parts = command.trim().split(/\s+/);
  const bin = parts[0] ?? "";
  const binName = basename(bin);
  if (!ALLOWED_COMMANDS.has(binName)) {
    return {
      command,
      exitCode: null,
      status: "error",
      output: `Command not allowed: ${binName}. Allowed: ${[...ALLOWED_COMMANDS].join(", ")}`,
      durationMs: 0,
    };
  }
  if (parts.some((part) => /[;&|`$<>]/.test(part))) {
    return {
      command,
      exitCode: null,
      status: "error",
      output: "Shell metacharacters are not allowed in this runner.",
      durationMs: 0,
    };
  }
  if (binName === "git" && !SAFE_GIT_COMMANDS.has(parts[1] ?? "")) {
    return {
      command,
      exitCode: null,
      status: "error",
      output: `Git subcommand not allowed: ${parts[1] ?? ""}. Allowed: ${[...SAFE_GIT_COMMANDS].join(", ")}`,
      durationMs: 0,
    };
  }
  if (
    bin === "git" &&
    parts[1] === "branch" &&
    parts.slice(2).some((part) => /^-(d|D|m|M|c|C)$|^--(delete|move|copy)$/.test(part))
  ) {
    return {
      command,
      exitCode: null,
      status: "error",
      output: "Mutating git branch operations are not allowed in this runner.",
      durationMs: 0,
    };
  }

  const sandbox = (process.env.SANDBOX_MODE ?? "process") === "bwrap" && binName !== "git";
  const spawnArgs = sandbox ? await sandboxArgs(root, bin, parts.slice(1)) : parts.slice(1);
  return new Promise<CommandResult>((resolvePromise) => {
    const child = spawn(sandbox ? "bwrap" : bin, spawnArgs, {
      cwd: root,
      shell: false,
      env: {
        PATH: sandbox
          ? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
          : process.env.PATH ?? "",
        HOME: sandbox ? "/tmp" : process.env.HOME ?? "",
        NODE_ENV: "test",
        CI: "1",
      },
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });

    let output = "";
    let timedOut = false;
    const append = (chunk: Buffer) => {
      if (output.length >= MAX_OUTPUT) return;
      output += chunk.toString("utf8").slice(0, MAX_OUTPUT - output.length);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => {
      output += `\n[spawn error] ${error.message}`;
    });
    child.on("close", (code, signal) => {
      if (signal === "SIGKILL") timedOut = true;
      const exitCode = typeof code === "number" ? code : null;
      resolvePromise({
        command,
        exitCode,
        status: timedOut ? "timeout" : exitCode === 0 ? "passed" : "failed",
        output: output.slice(0, MAX_OUTPUT),
        durationMs: Date.now() - started,
      });
    });
  });
}
