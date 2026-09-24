import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { isLoopbackHostname, rejectUntrustedRequest } from "./server/request-guard";

// Loopback by default; `pnpm dev:network` (vite --host 0.0.0.0) or VITE_HOST
// opts into LAN access for testing on other devices.
const DEV_HOST = process.env.VITE_HOST || "127.0.0.1";
const lanDev = process.argv.includes("--host") || !isLoopbackHostname(DEV_HOST);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    environment: "node",
    include: ["server/**/*.test.ts", "electron/**/*.test.mjs", "src/lib/**/*.test.ts"],
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
    host: DEV_HOST,
    port: 5199,
    // packager output lands inside the repo — its HTML files must never
    // trigger dev full-page reloads
    watch: {
      ignored: ["**/release/**", "**/build/**", "**/dist/**", "**/electron/resources/**"],
    },
    // the harness server owns every provider process; the app only ever
    // talks to /api — clients hold no transports
    //
    // The harness only trusts its own loopback origin, so the proxy applies
    // the same same-origin check against the dev page, then presents the
    // request to the harness as a local one.
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${process.env.GBS_PORT || 8899}`,
        changeOrigin: true,
        bypass(req, res) {
          const refused = rejectUntrustedRequest(req.headers, { allowAnyHost: lanDev });
          if (!refused) return undefined;
          res!.statusCode = 403;
          res!.setHeader("content-type", "application/json");
          res!.end(JSON.stringify({ error: refused }));
          // a string result with the response already ended stops vite here
          return req.url;
        },
        configure(proxy) {
          proxy.on("proxyReq", (proxyReq) => {
            proxyReq.removeHeader("origin");
            proxyReq.removeHeader("sec-fetch-site");
          });
        },
      },
    },
  },
});
