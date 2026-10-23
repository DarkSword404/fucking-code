import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const r = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@devteam/contracts": r("./packages/contracts/src/index.ts"),
      "@devteam/db": r("./packages/db/src/index.ts"),
      "@devteam/domain": r("./packages/domain/src/index.ts"),
      "@devteam/agents": r("./packages/agents/src/index.ts"),
      "@devteam/workspace": r("./packages/workspace/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    timeout: 60_000,
  },
});
