#!/usr/bin/env node
/**
 * Deployment preflight. Run from the repository root:
 *
 *   npx tsx scripts/preflight.ts
 *
 * It never prints secrets. Exit code 1 means the app cannot start correctly.
 */
import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readdirSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

type Level = "ok" | "warn" | "fail";
const checks: Array<{ level: Level; name: string; detail: string }> = [];
const add = (level: Level, name: string, detail = "") => checks.push({ level, name, detail });

function env(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

function command(bin: string, args: string[] = [], timeout = 8_000): string | null {
  try {
    return execFileSync(bin, args, {
      encoding: "utf8",
      timeout,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function hasCommand(bin: string): boolean {
  return command("sh", ["-lc", `command -v ${JSON.stringify(bin)}`]) !== null;
}

function browserPath(): string | null {
  const explicit = env("BROWSER_EXECUTABLE_PATH");
  if (explicit && existsSync(explicit)) return explicit;
  for (const candidate of [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  const cache = join(homedir(), ".cache", "ms-playwright");
  if (existsSync(cache)) {
    for (const entry of readdirSync(cache)) {
      if (!entry.startsWith("chromium")) continue;
      for (const suffix of [
        join("chrome-linux", "chrome"),
        join("chrome-linux64", "chrome"),
        join("chrome-linux", "headless_shell"),
      ]) {
        const candidate = join(cache, entry, suffix);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

async function portFree(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.once("error", () => resolvePromise(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolvePromise(true)));
  });
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile(process.env.ENV_FILE ?? ".env");
  } catch {
    add("warn", ".env", "未找到 .env，将使用 .env.example 的默认值；生产环境请先复制并修改");
  }

  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major > 22 || (major === 22 && minor >= 13)) {
    add("ok", "Node.js", process.version);
  } else {
    add("fail", "Node.js", `${process.version}，需要 22.13+`);
  }

  for (const bin of ["npm", "git", "curl"]) {
    if (hasCommand(bin)) add("ok", "命令", bin);
    else add("fail", "命令", `缺少 ${bin}`);
  }

  if (env("SANDBOX_MODE", "process") === "bwrap") {
    if (hasCommand("bwrap")) add("ok", "bubblewrap", command("bwrap", ["--version"]) ?? "present");
    else add("fail", "bubblewrap", "缺少 bwrap；安装 bubblewrap 或设置 SANDBOX_MODE=process");
  }

  const gateway = env("MODEL_GATEWAY", "opencode");
  if (gateway === "openai" || gateway === "openai-compatible") {
    if (env("MODEL_API_KEY") || env("OPENAI_API_KEY")) add("ok", "模型网关", "OpenAI-compatible");
    else add("fail", "模型网关", "MODEL_GATEWAY=openai 但缺少 MODEL_API_KEY / OPENAI_API_KEY");
  } else if (gateway === "echo" || gateway === "mock") {
    add("warn", "模型网关", "离线模式，不会调用真实模型");
  } else {
    if (!hasCommand("opencode")) {
      add("fail", "OpenCode", "缺少 opencode CLI；先运行官方安装脚本");
    } else {
      const version = command("opencode", ["--version"]) ?? "unknown";
      add("ok", "OpenCode", version);
      const status = command("opencode", ["service", "status"], 15_000);
      const serviceUrl = status?.match(/https?:\/\/[^\s]+/)?.[0] ?? null;
      if (serviceUrl) add("ok", "OpenCode 服务", serviceUrl);
      else
        add(
          "warn",
          "OpenCode 服务",
          "未运行；执行 opencode service start，或在管理后台完成网页验证后自动重启",
        );

      const auth = command("opencode", ["auth", "list"], 15_000);
      if (auth && /stored|已存储|已登录/i.test(auth)) add("ok", "OpenCode 登录", "存在已存储凭据");
      else
        add(
          "warn",
          "OpenCode 登录",
          "未登录；启动后在管理后台 → OpenCode 用网页验证完成（也可以 opencode auth import）",
        );

      const models = command("opencode", ["models"], 20_000);
      if (models) {
        const wanted = [
          `${env("AGENT_MODEL_PROVIDER", "opencode-go")}/${env("AGENT_MODEL_ID", "deepseek-v4.1-flash")}`,
          `${env("ATTENTION_MODEL_PROVIDER", "opencode-go")}/${env("ATTENTION_MODEL_ID", "mimo-v2.6-flash")}`,
        ];
        const available = new Set(models.split(/\s+/).filter(Boolean));
        for (const model of wanted) {
          if (available.has(model)) add("ok", "模型", model);
          else add("warn", "模型", `${model} 不在 opencode models 列表中`);
        }
      }

      const configured = env("OPENCODE_URL");
      if (configured && serviceUrl && configured.replace(/\/$/, "") !== serviceUrl.replace(/\/$/, "")) {
        add(
          "warn",
          "OPENCODE_URL",
          `配置为 ${configured}，但当前服务是 ${serviceUrl}；start.sh 会自动更新`,
        );
      }
    }
  }

  const authMode = env("AUTH_MODE", "dev");
  if (authMode === "dev") {
    add("warn", "AUTH_MODE", "dev 模式无登录，适合本机；公网部署请改成 session");
  } else if (authMode === "session") {
    if (env("SIGNUP_INVITE_CODE")) add("ok", "注册邀请码", "已配置");
    else add("warn", "注册邀请码", "SIGNUP_INVITE_CODE 为空；只能使用已有账号登录");
  }

  for (const key of ["PGDATA", "WORKSPACE_ROOT", "PROJECT_REPO_ROOT", "PROJECT_GIT_ROOT"]) {
    const dir = resolve(env(key, "./data"));
    try {
      mkdirSync(dir, { recursive: true });
      accessSync(dir, constants.W_OK);
      add("ok", "数据目录", `${key}=${dir}`);
    } catch {
      add("fail", "数据目录", `${key}=${dir} 不可写`);
    }
  }

  const browser = browserPath();
  if (browser) add("ok", "浏览器", browser);
  else add("warn", "浏览器", "未找到 Chrome/Chromium；workbench UI 走查会标未覆盖");

  if (env("RUNNER_MODE", "host") === "docker") {
    const docker = command("docker", ["info", "--format", "{{.ServerVersion}}"], 15_000);
    if (docker) add("ok", "Docker runner", docker);
    else add("fail", "Docker runner", "docker 不可用；安装 Docker 或设置 RUNNER_MODE=host");
    const image = env("RUNNER_IMAGE", "node:22-bookworm-slim");
    if (docker) {
      const inspected = command("docker", ["image", "inspect", image], 10_000);
      if (inspected) add("ok", "Runner 镜像", image);
      else add("warn", "Runner 镜像", `${image} 不存在；先 docker pull ${image}`);
    }
  }

  const port = Number(env("PORT", "8787"));
  if (await portFree(port)) add("ok", "端口", `${port} 可用`);
  else add("warn", "端口", `${port} 已被占用；如果服务已在运行可以忽略`);

  if (existsSync("apps/web/dist/index.html")) add("ok", "前端构建", "apps/web/dist");
  else add("warn", "前端构建", "缺少 apps/web/dist；start.sh 会构建");

  const icon: Record<Level, string> = { ok: "✓", warn: "!", fail: "✗" };
  console.log("\nFucking Code 部署检查\n");
  for (const check of checks) {
    console.log(`  ${icon[check.level]} ${check.name}${check.detail ? ` — ${check.detail}` : ""}`);
  }
  const failures = checks.filter((check) => check.level === "fail");
  const warnings = checks.filter((check) => check.level === "warn");
  console.log(
    `\n结果：${checks.length - failures.length - warnings.length} 通过，${warnings.length} 警告，${failures.length} 失败\n`,
  );
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
