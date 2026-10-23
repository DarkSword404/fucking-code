import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "./schema.js";

let client: PGlite | undefined;
let database: PgliteDatabase<typeof schema> | undefined;

export function getClient(): PGlite {
  if (!client) {
    const dataDir = resolve(process.env.PGDATA ?? "./data/pg");
    mkdirSync(dirname(dataDir), { recursive: true });
    client = new PGlite(dataDir);
  }
  return client;
}

export function getDb(): PgliteDatabase<typeof schema> {
  if (!database) {
    database = drizzle(getClient(), { schema });
  }
  return database;
}

export async function closeDb(): Promise<void> {
  await client?.close();
  client = undefined;
  database = undefined;
}

export { schema };
