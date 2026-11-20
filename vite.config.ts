import { readFileSync } from "node:fs";
import { isIPv4 } from "node:net";
import { fileURLToPath } from "node:url";
import { loadEnv, type Connect, type Plugin, type ProxyOptions, type ServerOptions } from "vite";
import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { DurationSequencer } from "./scripts/testing/duration-sequencer.ts";
import { hostE2eOnly, portableE2eFiles } from "./scripts/testing/host-e2e.ts";
import { hostTimeout } from "./server/testing/host-timeout.ts";
import { networkPeer } from "./server/request-auth.ts";

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
    return {
      target: `http://127.0.0.1:${env.OMB_PORT || process.env.OGB_PORT || 8799}`,
      bypass(request) {
        const address = request.socket.remoteAddress;
        if (address && networkPeer(request)) {
          request.headers["x-forwarded-for"] = address;
        }
      },
    };
  }
  const target = URL.parse(env.OMB_RAILWAY_ORIGIN ?? "");
  if (!target || target.protocol !== "https:" || target.href !== `${target.origin}/`) {
    throw new Error("Set OMB_RAILWAY_ORIGIN to an HTTPS origin in .env or in your shell.");
  }
  return {
    target: target.origin,
    changeOrigin: true,
    bypass(request) {
      const host = request.headers.host;
      if (request.headers.origin !== `http://${host}`) return;
      const address = request.socket.localAddress;
      if (host === `127.0.0.1:${port}` || (address && isIPv4(address) && host === `${address}:${port}`)) {
        request.headers.origin = target.origin;
      }
    },
  };
}

function devServer(mode: string): ServerOptions {
  const env = loadEnv(mode, root, "OMB_");
  const port = Number(env.OMB_UI_PORT) || (mode === "railway" ? 5200 : 5199);
  const proxy = backendProxy(mode, port, env);
  return {
    host: "0.0.0.0",
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

export default defineConfig(({ mode, command }) => ({
  plugins: [react(), tailwindcss(), railPage()],
  build: {
    rollupOptions: { input: { index: page("./index.html"), rail: page("./rail.html") } },
  },
  define: {
    __APP_VERSION__: JSON.stringify(version),
    "import.meta.env.VITE_CHAT_BACKEND": JSON.stringify(command === "serve" ? backendProxy(mode, 0, loadEnv(mode, root, "OMB_")).target : null),
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
