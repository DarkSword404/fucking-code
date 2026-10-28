import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";


try {
  process.loadEnvFile(process.env.ENV_FILE ?? ".env");
} catch {
  // .env is optional
}

const file = process.argv[2];
const force = process.argv.includes("--force");
if (!file) {
  console.error("Usage: npm run restore -- <backup.tar.gz> [--force]");
  process.exit(1);
}
if (!existsSync(file)) {
  console.error(`[restore] backup not found: ${file}`);
  process.exit(1);
}
if (!force) {
  console.error("[restore] Stop the API first, then pass --force to overwrite the current database.");
  process.exit(1);
}
const pgDir = resolve(process.env.PGDATA ?? "./data/pg");
execFileSync("rm", ["-rf", pgDir]);
execFileSync("mkdir", ["-p", dirname(pgDir)]);
execFileSync("tar", ["-xzf", resolve(file), "-C", dirname(pgDir)], { stdio: "inherit" });
console.log(`[restore] restored ${basename(file)} into ${pgDir}`);
