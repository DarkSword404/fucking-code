import { and, eq, inArray } from "drizzle-orm";
import type { SpecRef, TaskSpec } from "@devteam/contracts";
import { getDb } from "./client.js";
import { artifacts, artifactVersions } from "./schema.js";

/**
 * Snapshot the currently accepted PRD / acceptance criteria / contracts for a
 * task. Tasks must carry the exact spec versions they were planned against, so
 * a later edit cannot silently change what "done" means.
 */
export async function captureAcceptedSpec(projectId: string): Promise<TaskSpec | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.projectId, projectId),
        inArray(artifacts.kind, ["prd", "acceptance_criteria", "api_contract"]),
        eq(artifacts.status, "accepted"),
      ),
    );
  const prd = rows.find((row) => row.kind === "prd");
  const acceptance = rows.find((row) => row.kind === "acceptance_criteria");
  if (!prd || !acceptance) return null;

  const ref = (row: typeof prd): SpecRef => ({
    id: row.id,
    version: row.currentVersion,
    title: row.title,
  });

  return {
    prd: ref(prd),
    acceptance: ref(acceptance),
    contracts: rows.filter((row) => row.kind === "api_contract").map(ref),
    capturedAt: new Date().toISOString(),
  };
}

/** Render the exact captured spec versions for prompts and verification. */
export async function specContent(
  spec: TaskSpec | Record<string, never> | null,
  maxChars = 14_000,
): Promise<string> {
  if (!spec) return "";
  const typed = spec as TaskSpec;
  if (!typed.prd || !typed.acceptance) return "";

  const db = getDb();
  const refs: SpecRef[] = [typed.prd, typed.acceptance, ...(typed.contracts ?? [])];
  const sections: string[] = [];
  for (const ref of refs) {
    const [row] = await db
      .select()
      .from(artifactVersions)
      .where(
        and(
          eq(artifactVersions.artifactId, ref.id),
          eq(artifactVersions.version, ref.version),
        ),
      )
      .limit(1);
    if (row) sections.push(`### ${ref.title}（v${ref.version}）\n${row.content}`);
  }
  return sections.join("\n\n").slice(0, maxChars);
}
