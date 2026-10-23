import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { and, eq, gt } from "drizzle-orm";
import { getDb, sessions, users, type UserRow } from "@devteam/db";
import { uuidv7 } from "@devteam/domain";
import { isDemoMode } from "./demo.js";
import { hashSessionToken, newSessionToken } from "./password.js";

export const SESSION_COOKIE = "devteam_session";
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

function cookieSecure(c: Context): boolean {
  return process.env.COOKIE_SECURE === "true" || c.req.header("x-forwarded-proto") === "https";
}

export function bearerToken(c: Context): string | null {
  const header = c.req.header("authorization");
  return header?.startsWith("Bearer ") ? header.slice(7).trim() : null;
}

export async function createSession(c: Context, userId: string): Promise<string> {
  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  const db = getDb();
  await db.insert(sessions).values({
    id: uuidv7(),
    userId,
    tokenHash: hashSessionToken(token),
    expiresAt,
  });
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: cookieSecure(c),
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
  return token;
}

export async function destroySession(c: Context): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE) ?? bearerToken(c);
  if (token) {
    await getDb()
      .delete(sessions)
      .where(eq(sessions.tokenHash, hashSessionToken(token)));
  }
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

export async function userForSessionToken(token: string): Promise<UserRow | null> {
  const db = getDb();
  const [row] = await db
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(
      and(
        eq(sessions.tokenHash, hashSessionToken(token)),
        gt(sessions.expiresAt, new Date()),
        eq(users.isActive, true),
      ),
    )
    .limit(1);
  return row?.user ?? null;
}

export interface PublicUser {
  id: string;
  tenantId: string;
  email: string;
  displayName: string;
  authMode: string;
  demoMode: boolean;
  isAdmin: boolean;
}

export function publicUser(user: UserRow): PublicUser {
  return {
    id: user.id,
    tenantId: user.tenantId,
    email: user.email,
    displayName: user.displayName,
    authMode: process.env.AUTH_MODE ?? "dev",
    demoMode: isDemoMode(),
    isAdmin: user.isAdmin,
  };
}
