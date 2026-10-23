import { inArray } from "drizzle-orm";
import { closeDb, getDb, projects } from "@devteam/db";

const db = getDb();
const rows = await db.select().from(projects);
const groups = rows
  .filter((p) => p.name === "群聊验证")
  .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
const keep = groups[0];
const remove = groups.slice(1).map((p) => p.id);
if (remove.length) await db.delete(projects).where(inArray(projects.id, remove));
const remaining = await db.select({ id: projects.id, name: projects.name }).from(projects);
console.log({ kept: keep?.id, removed: remove.length, remaining });
await closeDb();
