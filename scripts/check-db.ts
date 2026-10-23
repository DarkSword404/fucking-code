import { closeDb, getClient, migrate, seed } from "@devteam/db";

await migrate();
await seed();
const c = getClient();
const counts = await c.query<{ table: string; n: number }>(`
  SELECT 'projects' AS table, COUNT(*)::int AS n FROM projects
  UNION ALL SELECT 'roles', COUNT(*)::int FROM agent_roles
  UNION ALL SELECT 'messages', COUNT(*)::int FROM messages
`);
console.log(counts.rows);
await closeDb();
