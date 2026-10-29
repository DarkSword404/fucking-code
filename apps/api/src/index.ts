import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { and, eq, inArray, isNull, lt } from "drizzle-orm";
import { closeDb, DEV_IDS, getDb, memories, migrate, normalizeArtifacts, projects, seed } from "@devteam/db";
import { cleanupManagedContainers, ensureDemoRepo } from "@devteam/workspace";

try {
  process.loadEnvFile(process.env.ENV_FILE ?? ".env");
} catch {
  // .env is optional; defaults are documented in .env.example
}

await migrate();
await normalizeArtifacts();
await seed();

// The demo project ships with a small local git repository so code tasks have
// a real worktree to operate on. New projects can set repoPath explicitly.
const repoPath = await ensureDemoRepo(process.env.DEMO_REPO_ROOT ?? "./data/repos");
const db = getDb();
await db
  .update(projects)
  .set({ repoPath })
  .where(and(eq(projects.id, DEV_IDS.project), isNull(projects.repoPath)));

const decayDays = Number(process.env.MEMORY_DECAY_DAYS ?? 180);
async function decayMemories(): Promise<void> {
  if (!Number.isFinite(decayDays) || decayDays <= 0) return;
  const cutoff = new Date(Date.now() - decayDays * 24 * 60 * 60 * 1000);
  const result = await db
    .update(memories)
    .set({ status: "superseded", updatedAt: new Date() })
    .where(
      and(
        inArray(memories.status, ["accepted", "proposed"]),
        lt(memories.updatedAt, cutoff),
      ),
    )
    .returning({ id: memories.id });
  if (result.length) console.log(`[devteam] decayed ${result.length} stale memories`);
}
await decayMemories();
setInterval(() => {
  void decayMemories().catch((error) => {
    console.error("[devteam] memory decay failed", error);
  });
}, 6 * 60 * 60 * 1000).unref();

const { cleanupOrphanedPreviews, stopAllPreviews } = await import("./preview.js");
cleanupManagedContainers("runner");
cleanupOrphanedPreviews();

const { app } = await import("./app.js");
const { recoverOrphanedTasks, startAutoDevelopmentLoop } = await import("./auto-dev.js");
await recoverOrphanedTasks();
startAutoDevelopmentLoop();

if (process.env.NODE_ENV === "production") {
  app.use("/*", async (c, next) => {
    await next();
    const contentType = c.res.headers.get("content-type") ?? "";
    if (contentType.includes("text/html")) {
      c.header("cache-control", "no-store, no-cache, must-revalidate");
      c.header("pragma", "no-cache");
      c.header("expires", "0");
      c.header("x-fucking-code-build", process.env.APP_BUILD ?? "dev");
    } else if (c.req.path.startsWith("/assets/")) {
      c.header("cache-control", "public, max-age=31536000, immutable");
    }
  });
  app.use("/*", serveStatic({ root: "./apps/web/dist" }));
  app.get("*", serveStatic({ path: "./apps/web/dist/index.html" }));
}

const port = Number(process.env.PORT ?? 8787);
const hostname = process.env.HOST ?? "127.0.0.1";

const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`[devteam] API listening on http://${info.address}:${info.port}`);
  console.log(`[devteam] demo repo: ${repoPath}`);
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[devteam] ${signal} received; shutting down cleanly`);
  try {
    await Promise.race([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000).unref()),
    ]);
  } catch {
    // ignore close errors
  }
  try {
    stopAllPreviews();
  } catch (error) {
    console.error("[devteam] failed to stop previews", error);
  }
  try {
    await closeDb();
  } catch (error) {
    console.error("[devteam] failed to close database", error);
  }
  process.exit(0);
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}
