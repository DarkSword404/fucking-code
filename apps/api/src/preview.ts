import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

interface PreviewState {
  projectId: string;
  token: string;
  port: number;
  process: ChildProcess;
  startedAt: number;
  output: string;
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

async function freePort(): Promise<number> {
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
    : ["install", "--omit=dev", "--no-audit", "--no-fund"];
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

async function waitForServer(port: number, child: ChildProcess, getOutput: () => string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`preview process exited: ${getOutput().slice(-1200) || `code ${child.exitCode}`}`);
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

export async function startPreview(projectId: string, repoPath: string): Promise<{ url: string; port: number }> {
  const existing = previews.get(projectId);
  if (existing && existing.process.exitCode === null) {
    return { url: `/preview/${existing.token}/`, port: existing.port };
  }
  if (existing) previews.delete(projectId);

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

  let output = "";
  const collect = (chunk: Buffer) => {
    output = `${output}${chunk.toString()}`.slice(-8000);
    const state = [...previews.values()].find((item) => item.process === child);
    if (state) state.output = output;
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);

  const token = randomBytes(18).toString("base64url");
  const state: PreviewState = { projectId, token, port, process: child, startedAt: Date.now(), output };
  previews.set(projectId, state);
  try {
    await waitForServer(port, child, () => output);
  } catch (error) {
    killPreview(child);
    previews.delete(projectId);
    throw error;
  }
  child.once("exit", () => {
    const current = previews.get(projectId);
    if (current?.process === child) previews.delete(projectId);
  });
  return { url: `/preview/${token}/`, port };
}

export function previewForToken(token: string): PreviewState | undefined {
  return [...previews.values()].find((preview) => preview.token === token);
}

export function stopPreview(projectId: string): void {
  const preview = previews.get(projectId);
  if (!preview) return;
  killPreview(preview.process);
  previews.delete(projectId);
}

export function stopAllPreviews(): void {
  for (const preview of previews.values()) killPreview(preview.process);
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
