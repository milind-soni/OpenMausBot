// Entry point: `npm start` serves Desk ATS on http://localhost:4100 (UI, API, MCP at /mcp).
import { existsSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createDesk } from "./desk.ts";
import { createApp } from "./http.ts";
import { createSim, type SimDelays } from "./sim.ts";
import { createStore, type Store } from "./store.ts";
import { createWebhookNotifier } from "./webhooks.ts";

interface Config {
  port: number;
  webhookUrl: string | null;
  webhookSecret: string | null;
  delays: Partial<SimDelays> | null;
}

const DEFAULTS: Config = { port: 4100, webhookUrl: null, webhookSecret: null, delays: null };
const ATS_DIR = fileURLToPath(new URL("..", import.meta.url));

/** ATS_CONFIG points at a config file outside the app folder (the hosted demo keeps it on a shared volume). */
function configPaths(rootDir: string): string[] {
  return process.env.ATS_CONFIG ? [process.env.ATS_CONFIG] : [join(rootDir, "config.json"), join(rootDir, "config.example.json")];
}

function readConfig(rootDir: string): Config {
  for (const path of configPaths(rootDir)) {
    if (existsSync(path)) {
      try {
        return { ...DEFAULTS, ...JSON.parse(readFileSync(path, "utf8")) };
      } catch {
        return DEFAULTS; // half-written by another process: try again on the next read
      }
    }
  }
  return DEFAULTS;
}

export async function startServer(opts: { rootDir?: string; port?: number; host?: string } = {}): Promise<{ url: string; store: Store; close(): Promise<void> }> {
  const rootDir = opts.rootDir ?? ATS_DIR;
  const config = readConfig(rootDir);
  const statePath = process.env.ATS_STATE ?? join(rootDir, "data", "state.json");
  const store = createStore({ statePath, seedPath: join(rootDir, "data", "seed.json") });
  const desk = createDesk(store);
  const sim = createSim(store, desk, config.delays ? { delays: config.delays } : {});
  // Re-read on every event: the hosted setup writes the webhook address after the ATS has started.
  const notifier = createWebhookNotifier(store, () => {
    const now = readConfig(rootDir);
    return { url: now.webhookUrl, secret: now.webhookSecret };
  });
  const app = createApp({ store, desk, sim });
  const host = opts.host ?? "127.0.0.1";
  const server = app.listen(opts.port ?? config.port, host);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${host}:${port}`,
    store,
    close: () => new Promise<void>((resolve) => {
      sim.stop();
      notifier.stop();
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

if (import.meta.main) {
  const { url } = await startServer();
  console.log(`Desk ATS on ${url.replace("127.0.0.1", "localhost")}  (MCP at ${url}/mcp)`);
}
