// Real engine screens with synthetic statuses and a disposable app server.
// No install/auth request can reach a provider or the user's configuration.
import { fileURLToPath } from "node:url";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "vite";
import type { InstanceInfo } from "../src/state/store.tsx";
import { launchVerificationServer } from "./control-omb.ts";

const instances: InstanceInfo[] = [
  ["claude", "claudeAgent", "Claude", true, "2.1.8"],
  ["codex", "codex", "Codex", true, "0.122.0"],
  ["grok", "grokAgent", "Grok", true, "grok"],
  ["opencode", "opencodeGo", "OpenCode", true, "1.18.25"],
  ["antigravity", "antigravityAgent", "Antigravity", false, "0.1.0"],
  ["kimi", "kimiAgent", "Kimi", false, ""],
  ["droid", "droidAgent", "Droid", false, ""],
  ["cursor", "cursorAgent", "Cursor", false, ""],
  ["hermes", "hermesAgent", "Hermes", false, ""],
  ["qwen", "qwenAgent", "Qwen", false, ""],
  ["pi", "piAgent", "Pi", false, ""],
].map(([id, driver, name, ready, version]) => ({
  instanceId: String(id), driverKind: String(driver), displayName: String(name),
  cliDefault: String(id),
  snapshot: { state: ready || version ? "available" : "unavailable", authenticated: Boolean(ready), version: String(version), ...(!ready && !version ? { reason: "Not installed in this isolated preview." } : {}) },
  models: { default: "fixture", options: [] },
  install: { command: { darwin: "echo 'Isolated preview — no installation'", linux: "echo 'Isolated preview — no installation'", win32: "echo Isolated preview — no installation" } },
}));
instances[0].snapshot.account = { email: "personal@example.test" };
instances[0].claudeAccount = { configDir: "", isDefault: true, signInCommand: "echo 'Preview only'", signInShell: "sh" };
instances[1].authentication = { method: "device-code", signOut: true };
instances[1].snapshot.account = { email: "work@example.test" };
instances[4].install = { managed: { label: "Install Antigravity", downloadBytes: 200_000_000 } };
instances[5].install!.server = { package: "kimi-fixture" };
instances[3].install!.server = { package: "opencode-fixture" };
instances[3].snapshot.update = { title: "OpenCode update available", message: "A sample update for this isolated preview.", command: "echo 'Preview only'" };
instances.push({ ...instances[0], instanceId: "claude-local", displayName: "Claude · Local", access: "custom", claudeAccount: undefined, snapshot: { state: "available", authenticated: false } });
const controller = new AbortController();
const cancel = () => controller.abort();
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);
let fixture: Awaited<ReturnType<typeof launchVerificationServer>> | undefined;
let ui: Awaited<ReturnType<typeof createServer>> | undefined;
const httpServer = createHttpServer();
try {
  fixture = await launchVerificationServer(process.env, controller.signal);
  controller.signal.throwIfAborted();
  ui = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    cacheDir: fileURLToPath(new URL("../.omb-scratch/engine-preview-vite", import.meta.url)),
    // Own the HTTP listener so Vite never installs a process-exit handler.
    server: { middlewareMode: { server: httpServer }, hmr: { server: httpServer }, proxy: { "/api": { target: fixture.info.url } } },
    plugins: [{ name: "isolated-engines", configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split("?")[0];
        const json = (value: unknown, status = 200) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(value)); };
        if (path === "/api/instances" && req.method === "GET") return json({ instances });
        if (path === "/__fixture/connect" && req.method === "POST") {
          instances[4].snapshot.authenticated = !instances[4].snapshot.authenticated;
          return json({ ok: true });
        }
        if (path === "/api/cli-candidates") return json({ candidates: ["/preview/bin/claude"] });
        if (path?.startsWith("/api/instances/") || path === "/api/cli-test") {
          return json({ error: "Preview only: no real account or installation is changed." }, 400);
        }
        if (path !== "/__engines.html") return next();
        void server.transformIndexHtml(req.url!, '<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>OpenMaus · Engine preview</title></head><body><div id="root"></div><script type="module" src="/scripts/testing/engines-preview.tsx"></script></body></html>')
          .then((html) => { res.setHeader("content-type", "text/html"); res.end(html); }).catch(next);
      });
    } }],
  });
  controller.signal.throwIfAborted();
  httpServer.on("request", ui.middlewares);
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("Preview server has no TCP address");
  console.log(JSON.stringify({ ...fixture.info, previewUrl: `http://127.0.0.1:${address.port}/__engines.html` }));
  await new Promise<void>((resolve) => {
    if (controller.signal.aborted) return resolve();
    controller.signal.addEventListener("abort", () => resolve(), { once: true });
  });
} finally {
  const httpClosed = new Promise<void>((resolve) => {
    // Closing an unstarted listener is harmless; active preview requests
    // must not hold shutdown open. Vite closes its own upgraded HMR sockets.
    httpServer.close(() => resolve());
    httpServer.closeAllConnections();
  });
  try {
    // Stop the app before waiting on Vite: unfinished import transforms can
    // delay Vite shutdown, but its cache no longer lives in fixture data.
    await fixture?.close();
  } finally {
    try {
      await ui?.close();
    } finally {
      try {
        await httpClosed;
      } finally {
        process.removeListener("SIGINT", cancel);
        process.removeListener("SIGTERM", cancel);
      }
    }
  }
}
