import { eq } from "drizzle-orm";
import { closeDb, DEV_IDS, getDb, users } from "@devteam/db";
import { hashPassword } from "../apps/api/src/password.js";

const password = process.argv[2] ?? process.env.DEV_PASSWORD;
if (!password || password.length < 8) {
  console.error("usage: tsx scripts/set-password.ts <password>");
  process.exit(1);
}

const db = getDb();
const [user] = await db.select().from(users).where(eq(users.id, DEV_IDS.user)).limit(1);
if (!user) {
  console.error("seed user not found; start the API once to run migrations/seed");
  await closeDb();
  process.exit(1);
}

await db.update(users).set({ passwordHash: hashPassword(password) }).where(eq(users.id, user.id));
console.log(`password set for ${user.email} (seed user)`);
await closeDb();
