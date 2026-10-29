import { randomBytes } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { appInstanceId, cleanupManagedContainers, defaultRunnerImage } from "@devteam/workspace";

interface PreviewState {
  projectId: string;
  token: string;
  port: number;
  url: string;
  startedAt: number;
  output: string;
  alive: () => boolean;
  stop: () => void;
}

function publicPreviewEnabled(): boolean {
  return process.env.PREVIEW_PUBLIC === "1";
}

function publicPreviewHost(): string {
  const explicit = process.env.PREVIEW_PUBLIC_HOST?.trim();
  if (explicit) return explicit;
  const base =
    process.env.PUBLIC_BASE_URL ??
    process.env.WEB_ORIGIN?.split(",")[0] ??
    "http://127.0.0.1";
  try {
    return new URL(base).hostname;
  } catch {
    return "127.0.0.1";
  }
}

function publicPreviewUrl(port: number): string {
  const scheme = process.env.PREVIEW_PUBLIC_SCHEME ?? "http";
  return `${scheme}://${publicPreviewHost()}:${port}/`;
}

const previews = new Map<string, PreviewState>();

function killPreview(child: ChildProcess): void {
  try {
    if (child.pid) process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

function canListen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "0.0.0.0", () => server.close(() => resolve(true)));
  });
}

async function freePort(): Promise<number> {
  const min = Number(process.env.PREVIEW_PORT_MIN ?? 0);
  const max = Number(process.env.PREVIEW_PORT_MAX ?? 0);
  if (min > 0 && max >= min) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const candidate = min + Math.floor(Math.random() * (max - min + 1));
      if (await canListen(candidate)) return candidate;
    }
  }
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error("no free preview port"))));
    });
  });
}

async function ensureDependencies(repoPath: string, hasPackage: boolean): Promise<void> {
  if (!hasPackage || existsSync(join(repoPath, "node_modules"))) return;
  const args = existsSync(join(repoPath, "package-lock.json"))
    ? ["ci", "--omit=dev", "--no-audit", "--no-fund"]
    : ["install", "--omit=dev", "--no-audit", "--no-fund", "--no-package-lock"];
  const child = spawn("npm", args, {
    cwd: repoPath,
    env: { ...process.env, NODE_ENV: "development" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output = `${output}${chunk.toString()}`.slice(-8000);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output = `${output}${chunk.toString()}`.slice(-8000);
  });
  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve(-1);
    }, 120_000);
    child.once("exit", (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
  if (code !== 0) {
    throw new Error(`preview dependency install failed: ${output.slice(-1200)}`);
  }
}

async function waitForServer(
  port: number,
  alive: () => boolean,
  getOutput: () => string,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (!alive()) {
      throw new Error(`preview process exited: ${getOutput().slice(-1200)}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(1200),
        redirect: "manual",
      });
      if (response.status < 500) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`preview did not start: ${getOutput().slice(-1200)}`);
}

const STATIC_SERVER = [
  "const h=require('node:http'),f=require('node:fs'),p=require('node:path');",
  "const r=process.env.REPO_PATH||'/workspace';",
  "const t={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.json':'application/json'};",
  "h.createServer((q,s)=>{let u=decodeURIComponent((q.url||'/').split('?')[0]);if(u.endsWith('/'))u+='index.html';",
  "let x=p.join(r,'public',u);if(!x.startsWith(p.join(r,'public')))return s.end();",
  "f.readFile(x,(e,b)=>{if(e){f.readFile(p.join(r,'public','index.html'),(e2,b2)=>{if(e2)return s.end('Not found');s.setHeader('content-type','text/html');s.end(b2)})}else{s.setHeader('content-type',t[p.extname(x)]||'application/octet-stream');s.end(b)}})}).listen(Number(process.env.PORT||0),'0.0.0.0')",
].join("");

interface DockerPreview {
  stop: () => void;
  alive: () => boolean;
  logs: ChildProcess;
  container: string;
}

function startDockerPreview(input: {
  repoPath: string;
  port: number;
  script: string | null;
  publicMode: boolean;
}): DockerPreview {
  const image = process.env.PREVIEW_IMAGE?.trim() || defaultRunnerImage(input.repoPath);
  const dockerBin = process.env.DOCKER_BIN ?? "docker";
  const container = `fc-preview-${randomBytes(6).toString("hex")}`;
  const volumesFrom =
    process.env.PREVIEW_VOLUMES_FROM?.trim() || process.env.RUNNER_VOLUMES_FROM?.trim();
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  const gid = typeof process.getgid === "function" ? process.getgid() : 1000;
  const command = input.script
    ? ["npm", "run", input.script]
    : ["node", "-e", STATIC_SERVER];
  const args = [
    "run",
    "-d",
    "--rm",
    "--name",
    container,
    "--init",
    "--pull=never",
    "--network",
    "bridge",
    "--memory",
    process.env.PREVIEW_MEMORY ?? "1g",
    "--cpus",
    process.env.PREVIEW_CPUS ?? "2",
    "--pids-limit",
    process.env.PREVIEW_PIDS_LIMIT ?? "256",
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    "--user",
    `${uid}:${gid}`,
    "--tmpfs",
    "/tmp:rw,size=256m",
    "--label",
    "fucking-code.managed=preview",
    "--label",
    `fucking-code.app=${appInstanceId()}`,
    "-e",
    "HOME=/tmp",
    "-e",
    `PORT=${input.port}`,
    "-e",
    "HOST=0.0.0.0",
    "-e",
    "BROWSER=none",
    "-e",
    "NODE_ENV=development",
    "-e",
    `REPO_PATH=${input.repoPath}`,
    "-p",
    `${input.publicMode ? "0.0.0.0" : "127.0.0.1"}:${input.port}:${input.port}`,
  ];
  if (volumesFrom) {
    args.push("--volumes-from", volumesFrom, "-w", input.repoPath);
  } else {
    args.push("-v", `${input.repoPath}:/workspace:rw`, "-w", "/workspace");
  }
  args.push(image, ...command);
  const run = spawnSync(dockerBin, args, { encoding: "utf8", timeout: 30_000 });
  if (run.status !== 0) {
    throw new Error(
      `preview container failed to start: ${(run.stderr || run.stdout || "unknown docker error").slice(-1200)}`,
    );
  }
  const logs = spawn(dockerBin, ["logs", "-f", container], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const alive = () => {
    const inspect = spawnSync(
      dockerBin,
      ["inspect", "-f", "{{.State.Running}}", container],
      { encoding: "utf8", timeout: 3_000 },
    );
    return inspect.status === 0 && inspect.stdout.trim() === "true";
  };
  return {
    logs,
    container,
    alive,
    stop: () => {
      try {
        logs.kill("SIGTERM");
      } catch {
        // ignore
      }
      spawn(dockerBin, ["rm", "-f", container], { stdio: "ignore" });
    },
  };
}

/** Remove preview containers left behind by a previous process. */
export function cleanupOrphanedPreviews(): number {
  return cleanupManagedContainers("preview");
}

export async function startPreview(projectId: string, repoPath: string): Promise<{ url: string; port: number }> {
  const existing = previews.get(projectId);
  if (existing && existing.alive()) {
    return { url: existing.url, port: existing.port };
  }
  if (existing) {
    existing.stop();
    previews.delete(projectId);
  }

  let scripts: Record<string, string> = {};
  let hasPackage = false;
  try {
    const pkg = JSON.parse(await readFile(join(repoPath, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    hasPackage = true;
    scripts = pkg.scripts ?? {};
  } catch {
    // A static-only project can still be previewed with a tiny server below.
  }
  await ensureDependencies(repoPath, hasPackage);

  const port = await freePort();
  const script = scripts.start ? "start" : scripts.dev ? "dev" : null;
  const mode = (process.env.PREVIEW_MODE ?? "host").toLowerCase();
  const token = randomBytes(18).toString("base64url");
  let output = "";
  let state: PreviewState;

  if (mode === "docker") {
    const publicMode = publicPreviewEnabled();
    const docker = startDockerPreview({ repoPath, port, script, publicMode });
    const url = publicMode ? publicPreviewUrl(port) : `/preview/${token}/`;
    const collect = (chunk: Buffer) => {
      output = `${output}${chunk.toString()}`.slice(-8000);
      state.output = output;
    };
    docker.logs.stdout?.on("data", collect);
    docker.logs.stderr?.on("data", collect);
    state = {
      projectId,
      token,
      port,
      url,
      startedAt: Date.now(),
      output,
      alive: docker.alive,
      stop: docker.stop,
    };
    previews.set(projectId, state);
    try {
      await waitForServer(port, docker.alive, () => output);
      const ttlMs = Number(process.env.PREVIEW_TTL_MS ?? 30 * 60_000);
      if (ttlMs > 0) {
        setTimeout(() => {
          if (previews.get(projectId) !== state) return;
          state.stop();
          previews.delete(projectId);
        }, ttlMs).unref();
      }
    } catch (error) {
      docker.stop();
      previews.delete(projectId);
      throw error;
    }
    return { url, port };
  }

  let child: ChildProcess;
  if (script) {
    child = spawn("npm", ["run", script], {
      cwd: repoPath,
      env: {
        ...process.env,
        PORT: String(port),
        HOST: "127.0.0.1",
        BROWSER: "none",
        NODE_ENV: "development",
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
  } else {
    child = spawn(
      process.execPath,
      [
        "-e",
        `const h=require('node:http'),f=require('node:fs'),p=require('node:path');const r=${JSON.stringify(repoPath)};const t={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.json':'application/json'};h.createServer((q,s)=>{let u=decodeURIComponent((q.url||'/').split('?')[0]);if(u.endsWith('/'))u+='index.html';let x=p.join(r,'public',u);if(!x.startsWith(p.join(r,'public')))return s.end();f.readFile(x,(e,b)=>{if(e){f.readFile(p.join(r,'public','index.html'),(e2,b2)=>{if(e2)return s.end('Not found');s.setHeader('content-type','text/html');s.end(b2)})}else{s.setHeader('content-type',t[p.extname(x)]||'application/octet-stream');s.end(b)}})}).listen(${port},'127.0.0.1')`,
      ],
      { cwd: repoPath, stdio: ["ignore", "pipe", "pipe"], detached: true },
    );
  }

  const collect = (chunk: Buffer) => {
    output = `${output}${chunk.toString()}`.slice(-8000);
    state.output = output;
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);

  state = {
    projectId,
    token,
    port,
    url: `/preview/${token}/`,
    startedAt: Date.now(),
    output,
    alive: () => child.exitCode === null,
    stop: () => killPreview(child),
  };
  previews.set(projectId, state);
  try {
    await waitForServer(port, () => child.exitCode === null, () => output);
  } catch (error) {
    killPreview(child);
    previews.delete(projectId);
    throw error;
  }
  child.once("exit", () => {
    const current = previews.get(projectId);
    if (current?.startedAt === state.startedAt) previews.delete(projectId);
  });
  const ttlMs = Number(process.env.PREVIEW_TTL_MS ?? 30 * 60_000);
  if (ttlMs > 0) {
    setTimeout(() => {
      if (previews.get(projectId) !== state) return;
      state.stop();
      previews.delete(projectId);
    }, ttlMs).unref();
  }
  return { url: state.url, port };
}

export function previewForToken(token: string): PreviewState | undefined {
  return [...previews.values()].find((preview) => preview.token === token);
}

/** Relative preview URL for a project, if one is running. */
export function previewUrlForProject(projectId: string): string | null {
  const preview = previews.get(projectId);
  return preview?.url ?? null;
}

export function stopPreview(projectId: string): void {
  const preview = previews.get(projectId);
  if (!preview) return;
  preview.stop();
  previews.delete(projectId);
}

export function stopAllPreviews(): void {
  for (const preview of previews.values()) preview.stop();
  previews.clear();
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => stopAllPreviews());
}

/** Rewrite JS/CSS absolute URLs while leaving data: URIs alone. */
export function rewritePreviewText(text: string, token: string): string {
  const prefix = `/preview/${token}`;
  return text
    .replace(/(["'])\/(?!\/|preview\/|data:|#)/g, (_match, quote: string) => `${quote}${prefix}/`)
    .replace(/(url\(\s*)\/(?!\/|preview\/|data:|#)/g, `$1${prefix}/`);
}

/** HTML attributes only; never touch inline data:image SVG payloads. */
export function rewritePreviewHtml(text: string, token: string): string {
  const prefix = `/preview/${token}`;
  return text
    .replace(/(\b(?:href|src|action|poster|data-src)=["'])\/(?!\/|data:|#)/gi, `$1${prefix}/`)
    .replace(/(url\(\s*)\/(?!\/|data:|#)/g, `$1${prefix}/`);
}
