import { and, eq, inArray, ne } from "drizzle-orm";
import { canonicalArtifactKey, uuidv7 } from "@devteam/domain";
import { getDb } from "./client.js";
import { artifacts, artifactVersions } from "./schema.js";

/**
 * Merges legacy artifacts that represent the same logical document but were
 * created under different titles ("PRD v1", "PRD v2", ...). Runs at boot and
 * is idempotent: afterwards every group has one artifact with all versions.
 */
export async function normalizeArtifacts(): Promise<void> {
  const db = getDb();
  const rows = await db.select().from(artifacts);
  if (!rows.length) return;

  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = canonicalArtifactKey(row.kind, row.title);
    const groupKey = `${row.projectId}:${row.kind}:${key}`;
    const list = groups.get(groupKey) ?? [];
    list.push(row);
    groups.set(groupKey, list);
  }

  for (const list of groups.values()) {
    const sorted = [...list].sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime());
    const canonical = sorted.at(-1);
    if (!canonical) continue;
    const key = canonicalArtifactKey(canonical.kind, canonical.title);

    if (list.length === 1) {
      if (canonical.artifactKey !== key) {
        await db.update(artifacts).set({ artifactKey: key }).where(eq(artifacts.id, canonical.id));
      }
      continue;
    }

    const ids = list.map((row) => row.id);
    const versions = await db
      .select()
      .from(artifactVersions)
      .where(inArray(artifactVersions.artifactId, ids));
    versions.sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.version - b.version,
    );

    // Rebuild the full version history on the canonical row.
    await db.delete(artifactVersions).where(inArray(artifactVersions.artifactId, ids));
    await db
      .delete(artifacts)
      .where(and(inArray(artifacts.id, ids), ne(artifacts.id, canonical.id)));
    await db
      .update(artifacts)
      .set({
        artifactKey: key,
        title: canonical.title,
        status: canonical.status,
        currentVersion: Math.max(versions.length, 1),
        createdAt: sorted[0]!.createdAt,
        updatedAt: canonical.updatedAt,
      })
      .where(eq(artifacts.id, canonical.id));

    let versionNumber = 1;
    for (const version of versions) {
      await db.insert(artifactVersions).values({
        id: uuidv7(),
        artifactId: canonical.id,
        version: versionNumber++,
        content: version.content,
        summary: version.summary,
        sourceMessageId: version.sourceMessageId,
        createdBy: version.createdBy,
        createdAt: version.createdAt,
      });
    }
  }
}
