import { execFile, spawn, type ChildProcess } from "node:child_process";
import { resetOpenCodeClientCache } from "@devteam/agents";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type OpenCodeAuthStatus =
  | "idle"
  | "pending"
  | "authorized"
  | "failed"
  | "cancelled"
  | "timeout";

export interface OpenCodeAuthState {
  status: OpenCodeAuthStatus;
  code: string | null;
  url: string | null;
  message: string;
  startedAt: string | null;
  finishedAt: string | null;
}

const TIMEOUT_MS = Number(process.env.OPENCODE_AUTH_TIMEOUT_MS ?? 10 * 60_000);

let child: ChildProcess | null = null;
let timer: NodeJS.Timeout | null = null;
let state: OpenCodeAuthState = {
  status: "idle",
  code: null,
  url: null,
  message: "还没有开始网页验证。",
  startedAt: null,
  finishedAt: null,
};

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

function parseOutput(text: string): { code: string | null; url: string | null } {
  const clean = stripAnsi(text).replace(/\r/g, "");
  const code = clean.match(/Enter code:\s*([A-Z0-9-]{4,})/i)?.[1] ?? null;
  const url = clean.match(/https?:\/\/[^\s]+/)?.[0] ?? null;
  return { code, url };
}

function killChild(): void {
  const processRef = child;
  child = null;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!processRef) return;
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      if (processRef.pid) process.kill(-processRef.pid, signal);
      else processRef.kill(signal);
    } catch {
      try {
        processRef.kill(signal);
      } catch {
        // already gone
      }
    }
  };
  signalGroup("SIGTERM");
  setTimeout(() => signalGroup("SIGKILL"), 2_000).unref();
}

async function hasStoredAuth(): Promise<boolean> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.env.OPENCODE_BIN ?? "opencode",
      ["auth", "list"],
      { encoding: "utf8", timeout: 15_000, env: process.env },
    );
    return /stored|已存储|已登录/i.test(`${stdout}${stderr}`);
  } catch {
    return false;
  }
}

/** Refresh "already logged in" without starting a new flow. */
export async function refreshOpenCodeAuthState(): Promise<OpenCodeAuthState> {
  if (state.status === "pending") return state;
  if (await hasStoredAuth()) {
    state = {
      ...state,
      status: "authorized",
      message: "OpenCode 已登录。",
    };
  }
  return state;
}

export function getOpenCodeAuthState(): OpenCodeAuthState {
  return state;
}

export async function startOpenCodeAuth(): Promise<OpenCodeAuthState> {
  if (child) return state;
  const target = process.env.OPENCODE_AUTH_TARGET ?? "opencode";
  const method = process.env.OPENCODE_AUTH_METHOD ?? "device";
  const bin = process.env.OPENCODE_BIN ?? "opencode";
  state = {
    status: "pending",
    code: null,
    url: null,
    message: "正在启动 OpenCode 网页验证…",
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };

  let output = "";
  const processRef = spawn(
    bin,
    ["auth", "login", target, "--method", method, "--standalone"],
    {
      env: process.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child = processRef;

  const collect = (chunk: Buffer) => {
    output = `${output}${chunk.toString("utf8")}`.slice(-20_000);
    const parsed = parseOutput(output);
    if (parsed.code || parsed.url) {
      state = {
        ...state,
        code: parsed.code ?? state.code,
        url: parsed.url ?? state.url,
        message: "请在浏览器中打开验证地址并输入验证码。",
      };
    }
  };
  processRef.stdout?.on("data", collect);
  processRef.stderr?.on("data", collect);

  processRef.on("error", (error) => {
    child = null;
    state = {
      ...state,
      status: "failed",
      message: `无法启动 OpenCode 登录：${error.message}`,
      finishedAt: new Date().toISOString(),
    };
  });

  processRef.on("close", (code, signal) => {
    const wasPending = state.status === "pending";
    child = null;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!wasPending) return;
    void hasStoredAuth().then((stored) => {
      if (stored) {
        state = {
          ...state,
          status: "authorized",
          message: "OpenCode 登录成功，服务正在刷新。",
          finishedAt: new Date().toISOString(),
        };
        void execFileAsync(bin, ["service", "restart"], {
          timeout: 30_000,
          env: process.env,
        })
          .catch(() => undefined)
          .finally(() => resetOpenCodeClientCache());
        return;
      }
      state = {
        ...state,
        status: signal === "SIGTERM" ? "cancelled" : code === 0 ? "failed" : "failed",
        message:
          stripAnsi(output)
            .replace(/\r/g, "")
            .trim()
            .slice(-1200) || `登录进程退出（code ${code ?? "?"}）`,
        finishedAt: new Date().toISOString(),
      };
    });
  });

  timer = setTimeout(() => {
    if (!child) return;
    killChild();
    state = {
      ...state,
      status: "timeout",
      message: "网页验证超时，请重新开始。",
      finishedAt: new Date().toISOString(),
    };
  }, TIMEOUT_MS);

  // Give the CLI a moment to print the device code; callers poll status.
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline && !state.code && !state.url) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return state;
}

export async function cancelOpenCodeAuth(): Promise<OpenCodeAuthState> {
  if (!child) {
    if (state.status === "pending") {
      state = {
        ...state,
        status: "cancelled",
        message: "已取消。",
        finishedAt: new Date().toISOString(),
      };
    }
    return state;
  }
  killChild();
  state = {
    ...state,
    status: "cancelled",
    message: "已取消 OpenCode 网页验证。",
    finishedAt: new Date().toISOString(),
  };
  return state;
}
