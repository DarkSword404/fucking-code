import { and, eq, inArray } from "drizzle-orm";
import { artifacts, closeDb, getDb, projects } from "@devteam/db";

const db = getDb();

await db.delete(projects).where(inArray(projects.name, ["Loop Test", "团队知识库 Demo"]));

const acme = await db
  .select()
  .from(projects)
  .where(eq(projects.name, "Acme Notes（示例项目）"))
  .limit(1);

if (acme[0]) {
  await db.update(projects).set({ phase: "build" }).where(eq(projects.id, acme[0].id));
  await db
    .update(artifacts)
    .set({ status: "accepted" })
    .where(
      and(
        eq(artifacts.projectId, acme[0].id),
        inArray(artifacts.kind, ["prd", "acceptance_criteria"]),
      ),
    );
}

const rows = await db.select({ id: projects.id, name: projects.name, phase: projects.phase }).from(projects);
console.log(rows);
await closeDb();
