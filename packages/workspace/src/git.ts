import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function git(cwd: string, args: string[], timeout = 60_000): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    timeout,
    maxBuffer: 20 * 1024 * 1024,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  return stdout;
}

export async function gitWithEnv(
  cwd: string,
  args: string[],
  extraEnv: Record<string, string>,
  timeout = 60_000,
): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    timeout,
    maxBuffer: 20 * 1024 * 1024,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      GIT_TERMINAL_PROMPT: "0",
      ...extraEnv,
    },
  });
  return stdout;
}

export async function gitSafe(cwd: string, args: string[], timeout = 60_000): Promise<string> {
  try {
    return await git(cwd, args, timeout);
  } catch {
    return "";
  }
}
