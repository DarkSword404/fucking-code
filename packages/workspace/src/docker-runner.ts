import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { CommandResult } from "./manager.js";

const MAX_OUTPUT = 200_000;

function firstExisting(root: string, names: string[]): string | null {
  for (const name of names) {
    if (existsSync(join(root, name))) return name;
  }
  return null;
}

/**
 * Pick a conservative default image from the repository contents. Users can
 * always override it with RUNNER_IMAGE for projects that need a custom image.
 */
export function defaultRunnerImage(root: string): string {
  const override = process.env.RUNNER_IMAGE?.trim();
  if (override) return override;
  if (firstExisting(root, ["package.json", "pnpm-lock.yaml", "yarn.lock"])) {
    return "node:22-bookworm-slim";
  }
  if (firstExisting(root, ["pyproject.toml", "requirements.txt", "poetry.lock"])) {
    return "python:3.12-slim";
  }
  return "node:22-bookworm-slim";
}

export interface DockerRunInput {
  root: string;
  command: string;
  bin: string;
  args: string[];
  timeoutMs: number;
  network: boolean;
}

/**
 * Execute an allow-listed command inside a short-lived container. The workspace
 * is the only bind mount; the container gets no host network by default and
 * has CPU/memory/process limits. Git operations intentionally stay on the host.
 */
export async function dockerRunCommand(input: DockerRunInput): Promise<CommandResult> {
  const started = Date.now();
  const image = defaultRunnerImage(input.root);
  const dockerBin = process.env.DOCKER_BIN ?? "docker";
  const name = `fc-run-${randomBytes(6).toString("hex")}`;
  const volumesFrom = process.env.RUNNER_VOLUMES_FROM?.trim();
  const workdir = volumesFrom ? input.root : "/workspace";
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  const gid = typeof process.getgid === "function" ? process.getgid() : 1000;

  if ((process.env.RUNNER_MODE ?? "host").toLowerCase() !== "docker") {
    return {
      command: input.command,
      exitCode: null,
      status: "error",
      output: "dockerRunCommand called while RUNNER_MODE is not docker",
      durationMs: 0,
    };
  }

  const args = [
    "run",
    "--rm",
    "--name",
    name,
    "--init",
    "--pull=never",
    "--network",
    input.network ? "bridge" : "none",
    "--memory",
    process.env.RUNNER_MEMORY ?? "1g",
    "--cpus",
    process.env.RUNNER_CPUS ?? "2",
    "--pids-limit",
    process.env.RUNNER_PIDS_LIMIT ?? "256",
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    "--user",
    `${uid}:${gid}`,
    "--tmpfs",
    "/tmp:rw,size=256m",
    "-e",
    "HOME=/tmp",
    "-e",
    "NODE_ENV=test",
    "-e",
    "CI=1",
  ];
  if (volumesFrom) {
    args.push("--volumes-from", volumesFrom, "-w", workdir);
  } else {
    args.push("-v", `${input.root}:/workspace:rw`, "-w", "/workspace");
  }
  args.push(image, input.bin, ...input.args);

  return new Promise<CommandResult>((resolvePromise) => {
    const child = spawn(dockerBin, args, {
      cwd: input.root,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const append = (chunk: Buffer) => {
      if (output.length >= MAX_OUTPUT) return;
      output += chunk.toString("utf8").slice(0, MAX_OUTPUT - output.length);
    };
    const finish = (status: CommandResult["status"], exitCode: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolvePromise({
        command: input.command,
        exitCode,
        status,
        output: output.slice(0, MAX_OUTPUT),
        durationMs: Date.now() - started,
      });
    };

    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => {
      output += `\n[docker spawn error] ${error.message}`;
      finish("error", null);
    });

    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      spawn(dockerBin, ["rm", "-f", name], { stdio: "ignore" });
    }, input.timeoutMs);

    child.on("close", (code, signal) => {
      if (signal === "SIGKILL" || timedOut) {
        finish("timeout", null);
        return;
      }
      const exitCode = typeof code === "number" ? code : null;
      finish(exitCode === 0 ? "passed" : exitCode === null ? "error" : "failed", exitCode);
    });
  });
}
