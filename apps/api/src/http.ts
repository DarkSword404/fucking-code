import { eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { ZodError } from "zod";
import { getDb, users, type UserRow } from "@devteam/db";
import { DEV_IDS } from "@devteam/db";
import { bearerToken, SESSION_COOKIE, userForSessionToken } from "./auth.js";

export interface AppEnv {
  Variables: {
    user: UserRow;
    requestId: string;
  };
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const requestId: MiddlewareHandler<AppEnv> = async (c, next) => {
  const id = c.req.header("x-request-id") ?? crypto.randomUUID();
  c.set("requestId", id);
  c.header("x-request-id", id);
  await next();
};

async function devUser(): Promise<UserRow> {
  const db = getDb();
  const [row] = await db.select().from(users).where(eq(users.id, DEV_IDS.user)).limit(1);
  if (!row) throw new HttpError(500, "DEV_USER_MISSING", "Local seed user is missing.");
  return row;
}

export const authenticate: MiddlewareHandler<AppEnv> = async (c, next) => {
  // Login / registration / logout manage their own credentials.
  if (c.req.path.startsWith("/api/v1/auth/")) return next();

  const mode = process.env.AUTH_MODE ?? "dev";

  if (mode === "dev") {
    c.set("user", await devUser());
    return next();
  }

  if (mode === "session") {
    const token = getCookie(c, SESSION_COOKIE) ?? bearerToken(c);
    if (!token) throw new HttpError(401, "UNAUTHENTICATED", "Authentication required.");
    const user = await userForSessionToken(token);
    if (!user) throw new HttpError(401, "UNAUTHENTICATED", "Authentication required.");
    c.set("user", user);
    return next();
  }

  // Header mode for trusted reverse proxies / API clients.
  const header = c.req.header("authorization");
  const id = header?.startsWith("Bearer ") ? header.slice(7).trim() : c.req.header("x-user-id");
  if (!id) throw new HttpError(401, "UNAUTHENTICATED", "Authentication required.");

  const db = getDb();
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  if (!row) throw new HttpError(401, "UNAUTHENTICATED", "Authentication required.");
  c.set("user", row);
  await next();
};

/**
 * CSRF defence for cookie-based sessions: reject cross-origin state changes.
 * Requests without an Origin header (curl, server-to-server) are allowed; the
 * session cookie is HttpOnly + SameSite=Lax.
 */
export const originGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return next();
  const origin = c.req.header("origin");
  if (!origin) return next();
  const allowed = (
    process.env.WEB_ORIGIN ??
    "http://127.0.0.1:5174,http://localhost:5174,http://127.0.0.1:8787"
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!allowed.includes(origin)) {
    throw new HttpError(403, "ORIGIN_NOT_ALLOWED", "Origin not allowed.");
  }
  await next();
};

export function jsonError(c: Context<AppEnv>, error: unknown) {
  if (error instanceof HttpError) {
    return c.json(
      {
        error: {
          code: error.code,
          message: error.message,
          requestId: c.get("requestId") ?? "",
          ...(error.details ? { details: error.details } : {}),
        },
      },
      error.status as 400,
    );
  }
  if (error instanceof ZodError) {
    return c.json(
      {
        error: {
          code: "INVALID_REQUEST",
          message: error.issues[0]?.message ?? "Invalid request body.",
          requestId: c.get("requestId") ?? "",
          details: error.issues,
        },
      },
      400,
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error("[api] unhandled error", message);
  return c.json(
    {
      error: {
        code: "INTERNAL_ERROR",
        message: "Internal server error.",
        requestId: c.get("requestId") ?? "",
      },
    },
    500,
  );
}
