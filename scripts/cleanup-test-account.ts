import { eq, like } from "drizzle-orm";
import { closeDb, getDb, tenants, users } from "@devteam/db";

const db = getDb();
const rows = await db.select().from(users).where(like(users.email, "tester-%@example.com"));
for (const user of rows) {
  await db.delete(tenants).where(eq(tenants.id, user.tenantId));
}
console.log(`removed ${rows.length} test account(s)`);
await closeDb();
