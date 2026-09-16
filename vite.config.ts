import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The About dialog shows the shipped version; package.json is the one place
// it is already maintained, so it is inlined at build time rather than
// round-tripped through the preload bridge (which is absent in dev).
const { version } = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8"),
) as { version: string };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  test: {
    alias: {
      // The Picovoice wake-word engines ship browser-wasm entry points that
      // Node cannot resolve; tests exercise the logic around them through
      // Node-resolvable stubs (which individual tests may vi.mock).
      "@picovoice/porcupine-web": fileURLToPath(new URL("./src/testing/porcupine-web-stub.ts", import.meta.url)),
      "@picovoice/web-voice-processor": fileURLToPath(new URL("./src/testing/web-voice-processor-stub.ts", import.meta.url)),
    },
    environment: "node",
    include: [
      "server/**/*.test.ts",
      "electron/**/*.test.mjs",
      "src/**/*.test.ts",
      "shared/**/*.test.ts",
      "companion/**/*.test.ts",
      "enterprise/**/*.test.ts",
      "scripts/**/*.test.mjs",
      "scripts/**/*.test.ts",
    ],
    setupFiles: ["server/testing/setup.ts"],
    // the suite spawns fake provider CLIs and a real harness server;
    // parallel files introduce load-sensitive flakes for no win
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    // IPv4 explicitly — a bare ::1 bind makes localhost a coin-flip for
    // clients that resolve IPv4 first
    host: "127.0.0.1",
    port: Number(process.env.ASTRA_UI_PORT) || 5199,
    // packager output lands inside the repo — its HTML files must never
    // trigger dev full-page reloads
    watch: {
      ignored: ["**/release/**", "**/build/**", "**/dist/**", "**/electron/resources/**"],
    },
    // the harness server owns every provider process; the app only ever
    // talks to /api — clients hold no transports
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${process.env.ASTRA_PORT || process.env.OGB_PORT || 8799}`,
      },
    },
  },
});
