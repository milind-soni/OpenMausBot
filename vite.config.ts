import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    environment: "node",
    include: [
      "server/**/*.test.ts",
      "electron/**/*.test.mjs",
      "src/**/*.test.ts",
      "companion/**/*.test.ts",
      "scripts/**/*.test.mjs",
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
    // 0.0.0.0 so Tailscale (and LAN) can reach the UI; loopback still works.
    // allowedHosts: true is required in Vite 7 or Host 100.x is blocked.
    host: process.env.OMB_UI_HOST || "0.0.0.0",
    port: Number(process.env.OMB_UI_PORT) || 5199,
    allowedHosts: true,
    // packager output lands inside the repo — its HTML files must never
    // trigger dev full-page reloads
    watch: {
      ignored: ["**/release/**", "**/build/**", "**/dist/**", "**/electron/resources/**"],
    },
    // the harness server owns every provider process; the app only ever
    // talks to /api — clients hold no transports
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${process.env.OMB_PORT || process.env.OGB_PORT || 8799}`,
        // Remote UI (Tailscale / LAN) presents as localhost so the harness
        // loopback Host/Origin gate still accepts the proxied /api stream.
        changeOrigin: true,
        timeout: 0,
        proxyTimeout: 0,
        configure(proxy) {
          proxy.on("proxyReq", (proxyReq) => {
            proxyReq.setHeader("host", `127.0.0.1:${process.env.OMB_PORT || process.env.OGB_PORT || 8799}`);
            proxyReq.removeHeader("origin");
          });
          proxy.on("proxyRes", (proxyRes) => {
            const contentType = String(proxyRes.headers["content-type"] ?? "");
            if (!contentType.includes("text/event-stream")) return;
            proxyRes.headers["cache-control"] = "no-cache, no-transform";
            proxyRes.headers["x-accel-buffering"] = "no";
            proxyRes.headers["connection"] = "keep-alive";
          });
        },
      },
    },
  },
});
