import { and, eq, inArray, like } from "drizzle-orm";
import { closeDb, getDb, messages, tasks } from "@devteam/db";

const PROJECT_ID = "01a16263-3761-7d93-a94e-7ff9f801cdf6";
const META_TITLES = [
  "修订 PRD v3 §5 周汇总字段定义",
  "出具 AC v4 定稿并硬化 A10a",
  "复核契约 v2 与 README/PRD 字段映射一致性",
  "收口前置阻塞并确认进入 build 的门槛",
];

const db = getDb();
const removedTasks = await db
  .delete(tasks)
  .where(and(eq(tasks.projectId, PROJECT_ID), inArray(tasks.title, META_TITLES)))
  .returning({ id: tasks.id });
const removedMessages = await db
  .delete(messages)
  .where(and(eq(messages.projectId, PROJECT_ID), like(messages.content, "计划已落成%")))
  .returning({ id: messages.id });

const remaining = await db.select({ title: tasks.title, status: tasks.status }).from(tasks).where(eq(tasks.projectId, PROJECT_ID));
console.log("removed tasks", removedTasks.length, "removed messages", removedMessages.length);
console.log(remaining);
await closeDb();
