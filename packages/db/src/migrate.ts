import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getClient } from "./client.js";

const here = dirname(fileURLToPath(import.meta.url));

export async function migrate(): Promise<void> {
  for (const file of ["0001_init.sql", "0002_lifecycle_stages.sql", "0003_task_mode.sql", "0004_repo_tokens.sql", "0005_repo_sync.sql", "0006_attachments.sql", "0007_attachment_archives.sql", "0008_auto_pause_reason.sql"]) {
    const sql = await readFile(join(here, "../migrations", file), "utf8");
    await getClient().exec(sql);
  }
}
