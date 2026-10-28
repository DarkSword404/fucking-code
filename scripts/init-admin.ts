import { randomBytes } from "node:crypto";

try {
  process.loadEnvFile(process.env.ENV_FILE ?? ".env");
} catch {
  // .env is optional
}

const { closeDb, DEV_IDS, getDb, migrate, seed, users } = await import("@devteam/db");
const { eq } = await import("drizzle-orm");
const { hashPassword } = await import("../apps/api/src/password.js");

const provided = process.argv[2] ?? process.env.ADMIN_PASSWORD ?? process.env.DEV_PASSWORD;
const password = provided ?? randomBytes(12).toString("base64url");
if (password.length < 8) {
  console.error("password must be at least 8 characters");
  process.exit(1);
}

await migrate();
await seed();
const db = getDb();
const [user] = await db.select().from(users).where(eq(users.id, DEV_IDS.user)).limit(1);
if (!user) {
  console.error("seed user missing; startup migration failed");
  await closeDb();
  process.exit(1);
}

await db
  .update(users)
  .set({ passwordHash: hashPassword(password), isAdmin: true, isActive: true })
  .where(eq(users.id, user.id));

console.log("Admin account ready:");
console.log(`  email:    ${user.email}`);
console.log(`  password: ${password}`);
console.log("Store this password now; it is not written to .env.");
await closeDb();
