import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Issue #1503 tier 1 ships as pure addition: the root vite.config.ts include
// list is untouched, so this dedicated config is what wires the evals in.
// Root is pinned to the repo so server/testing/setup.ts and the include glob
// resolve exactly as the root suite does.
export default defineConfig({
  root: fileURLToPath(new URL("..", import.meta.url)),
  test: {
    environment: "node",
    include: ["evals/**/*.test.ts"],
    setupFiles: ["server/testing/setup.ts"],
    // the e2e scenarios boot verification servers and fake provider CLIs;
    // parallel files introduce load-sensitive flakes for no win
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
