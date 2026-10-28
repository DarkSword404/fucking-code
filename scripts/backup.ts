import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";


try {
  process.loadEnvFile(process.env.ENV_FILE ?? ".env");
} catch {
  // .env is optional
}

const pgDir = resolve(process.env.PGDATA ?? "./data/pg");
const root = resolve("backups");
mkdirSync(root, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const out = resolve(root, `fucking-code-${stamp}.tar.gz`);
execFileSync("tar", ["-czf", out, "-C", dirname(pgDir), basename(pgDir)], {
  stdio: "inherit",
});
console.log(`[backup] wrote ${out}`);
console.log("[backup] stop the API before restoring; this archive includes the PGlite data directory.");
