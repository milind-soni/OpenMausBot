// Real browser UI against a disposable server with explicit self-host policy.
import { createServer as createHttpServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchVerificationServer } from "./control-omb.ts";

const abort = new AbortController();
process.once("SIGINT", () => abort.abort());
process.once("SIGTERM", () => abort.abort());
const http = createHttpServer();
const fixture = await launchVerificationServer({}, abort.signal, undefined, undefined, undefined, undefined, [], undefined, { browserFullAccess: true });
let ui: Awaited<ReturnType<typeof createServer>> | undefined;
try {
  await fetch(`${fixture.info.url}/api/bots`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Browser approval fixture" }) }).then(async response => {
    if (!response.ok) throw new Error(await response.text());
  });
  ui = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    cacheDir: fileURLToPath(new URL("../.omb-scratch/browser-approval-vite", import.meta.url)),
    server: { middlewareMode: { server: http }, hmr: { server: http }, proxy: { "/api": { target: fixture.info.url } } },
    plugins: [{ name: "browser-approval-fixture", configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url !== "/__browser-approvals.html") return next();
        void server.transformIndexHtml(req.url, '<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/scripts/testing/browser-approvals-preview.tsx"></script></body></html>')
          .then(html => { res.setHeader("content-type", "text/html"); res.setHeader("x-openmausbot-fixture", "browser-approvals"); res.end(html); }).catch(next);
      });
    } }],
  });
  abort.signal.throwIfAborted();
  http.on("request", ui.middlewares);
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  console.log(JSON.stringify({ ...fixture.info, previewUrl: `http://127.0.0.1:${address.port}/__browser-approvals.html` }));
  await new Promise<void>(resolve => { if (abort.signal.aborted) resolve(); else abort.signal.addEventListener("abort", () => resolve(), { once: true }); });
} finally {
  http.closeAllConnections();
  http.close();
  await fixture.close();
  await ui?.close();
}
