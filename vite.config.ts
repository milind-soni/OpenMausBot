import { readFileSync } from "node:fs";
import type { ClientRequest, IncomingMessage } from "node:http";
import { fileURLToPath } from "node:url";
import { loadEnv, type Connect, type Plugin, type ProxyOptions, type ServerOptions } from "vite";
import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { DurationSequencer } from "./scripts/testing/duration-sequencer.ts";
import { hostE2eOnly, portableE2eFiles } from "./scripts/testing/host-e2e.ts";
import { hostTimeout } from "./server/testing/host-timeout.ts";

// The About dialog's version, inlined at build time: the preload bridge is
// absent in dev.
const { version } = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8"),
) as { version: string };

const root = fileURLToPath(new URL(".", import.meta.url));
const workers = Number(process.env.OMB_VITEST_WORKERS) || 1;
const page = (file: string) => fileURLToPath(new URL(file, import.meta.url));

/** The window's rail of places loads /rail: rail.html, its own small page, in development as from the server. */
function railPage(): Plugin {
  const rewrite: Connect.NextHandleFunction = (req, _res, next) => {
    if (req.url === "/rail" || req.url?.startsWith("/rail?")) req.url = `/rail.html${req.url.slice("/rail".length)}`;
    next();
  };
  return {
    name: "rail-page",
    configureServer: (server) => void server.middlewares.use(rewrite),
    configurePreviewServer: (server) => void server.middlewares.use(rewrite),
  };
}

const include = [
  "evals/**/*.test.ts",
  "server/**/*.test.ts",
  "electron/**/*.test.mjs",
  "src/**/*.test.ts",
  "shared/**/*.test.ts",
  "companion/**/*.test.ts",
  "enterprise/**/*.test.ts",
  "connector/**/*.test.ts",
  "scripts/**/*.test.mjs",
  "scripts/**/*.test.ts",
];

function backendProxy(mode: string, port: number, env: Record<string, string>): ProxyOptions {
  if (mode !== "railway") {
    return { target: `http://127.0.0.1:${process.env.OMB_PORT || process.env.OGB_PORT || 8799}` };
  }
  const target = URL.parse(env.OMB_RAILWAY_ORIGIN ?? "");
  if (!target || target.protocol !== "https:" || target.href !== `${target.origin}/`) {
    throw new Error("Set OMB_RAILWAY_ORIGIN to an HTTPS origin in .env or in your shell.");
  }
  return {
    target: target.origin,
    changeOrigin: true,
    configure(server) {
      // Keep the production same-origin check effective for requests from any other page.
      const forwardLocalOrigin = (outgoing: ClientRequest, request: IncomingMessage) => {
        const host = `127.0.0.1:${port}`;
        if (request.headers.host === host && request.headers.origin === `http://${host}`) {
          outgoing.setHeader("origin", target.origin);
        }
      };
      server.on("proxyReq", forwardLocalOrigin);
      server.on("proxyReqWs", forwardLocalOrigin);
    },
  };
}

function devServer(mode: string): ServerOptions {
  const env = loadEnv(mode, root, "OMB_");
  const port = Number(env.OMB_UI_PORT) || (mode === "railway" ? 5200 : 5199);
  const proxy = backendProxy(mode, port, env);
  return {
    // IPv4 explicitly — a bare ::1 bind makes localhost a coin-flip for
    // clients that resolve IPv4 first
    host: "127.0.0.1",
    port,
    strictPort: mode === "railway",
    // packager output lands inside the repo — its HTML files must never
    // trigger dev full-page reloads
    watch: {
      ignored: ["**/release/**", "**/build/**", "**/dist/**", "**/electron/resources/**"],
    },
    // the harness server owns every provider process; the app only ever
    // talks to /api — clients hold no transports
    proxy: {
      "/api": {
        ...proxy,
        ws: true,
      },
      "/.well-known/openmausbot/environment": proxy,
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), railPage()],
  build: {
    rollupOptions: { input: { index: page("./index.html"), rail: page("./rail.html") } },
  },
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  test: {
    environment: "node",
    include,
    // OMB_VITEST_E2E=host (CI's Windows and macOS shards) leaves the e2e files that run on Linux only.
    exclude: [...configDefaults.exclude, ...(hostE2eOnly() ? portableE2eFiles(root, include) : [])],
    setupFiles: ["server/testing/setup.ts", "src/testing/all-locales.ts"],
    // One file at a time by default: the suite spawns fake provider CLIs and real
    // harness servers, which a laptop feels. CI sets its runner's count (scripts/ci-scope.mjs).
    fileParallelism: workers > 1,
    maxWorkers: workers,
    // --shard splits the files by recorded CI seconds, not count
    sequence: { sequencer: DurationSequencer },
    // Known flakes in scripts/testing/ci-retry-list.json get two retries in
    // CI only, each reported.
    runner: "./scripts/testing/ci-retry-runner.ts",
    // Doubled on Windows, whose runners are about 1.45x slower.
    testTimeout: hostTimeout(20_000),
    hookTimeout: hostTimeout(30_000),
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: devServer(mode),
}));
