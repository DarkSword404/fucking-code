import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getClient } from "./client.js";

const here = dirname(fileURLToPath(import.meta.url));

export async function migrate(): Promise<void> {
  const sql = await readFile(join(here, "../migrations/0001_init.sql"), "utf8");
  await getClient().exec(sql);
}
