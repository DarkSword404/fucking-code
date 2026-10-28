import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

let cachedUrl: string | null = null;

export function serviceUrl(): string {
  if (cachedUrl) return cachedUrl;
  if (process.env.OPENCODE_URL) {
    cachedUrl = process.env.OPENCODE_URL.replace(/\/$/, "");
    return cachedUrl;
  }
  try {
    const out = execFileSync("opencode", ["service", "status"], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const match = out.match(/https?:\/\/[^\s]+/);
    if (match) {
      cachedUrl = match[0].replace(/\/$/, "");
      return cachedUrl;
    }
  } catch {
    // fall through to the documented default
  }
  cachedUrl = "http://127.0.0.1:4096";
  return cachedUrl;
}

export function servicePassword(): string | null {
  if (process.env.OPENCODE_PASSWORD) return process.env.OPENCODE_PASSWORD;
  try {
    const raw = readFileSync(join(homedir(), ".config", "opencode", "service.json"), "utf8");
    const parsed = JSON.parse(raw) as { password?: string };
    return parsed.password ?? null;
  } catch {
    return null;
  }
}

/** Clear URL/auth caches after login or service restart. */
export function resetOpenCodeClientCache(): void {
  cachedUrl = null;
  cachedAuth = undefined;
}

let cachedAuth: string | null | undefined;

export function authHeader(): string | null {
  if (cachedAuth !== undefined) return cachedAuth;
  const password = servicePassword();
  if (!password) {
    cachedAuth = null;
    return null;
  }
  const username = process.env.OPENCODE_USERNAME ?? "opencode";
  cachedAuth = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  return cachedAuth;
}

export interface OpenCodeResponse<T = unknown> {
  ok: boolean;
  status: number;
  data: T;
  raw: string;
}

/** Thin authenticated JSON client for the local/remote OpenCode server. */
export async function opencodeFetch<T = unknown>(
  path: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<OpenCodeResponse<T>> {
  const timeout = AbortSignal.timeout(init?.timeoutMs ?? 60_000);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...((init?.headers as Record<string, string> | undefined) ?? {}),
  };
  const auth = authHeader();
  if (auth) headers.authorization = auth;

  const res = await fetch(`${serviceUrl()}${path}`, {
    ...init,
    headers,
    signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
  });
  const raw = await res.text();
  let data: unknown = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = raw;
  }
  return { ok: res.ok, status: res.status, data: data as T, raw };
}
