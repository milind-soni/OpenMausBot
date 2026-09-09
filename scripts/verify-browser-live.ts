// Actual browser + actual BrowserPanel, always in a disposable fixture HOME.
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createServer } from "vite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";

const binaryPath = process.env.OMB_VERIFY_BROWSER_BINARY;
const executablePath = process.env.OMB_VERIFY_BROWSER_CHROME;
if (!binaryPath || !executablePath) throw new Error("Set OMB_VERIFY_BROWSER_BINARY and OMB_VERIFY_BROWSER_CHROME to explicit installed binaries.");
const fixture = await launchVerificationServer(process.env, undefined, undefined, { binaryPath, executablePath });
let ui: Awaited<ReturnType<typeof createServer>> | undefined;
try {
  await runControlOmb(["new-bot", "--name", "Pepper", "--url", fixture.info.url]);
  const { bots } = await (await fetch(`${fixture.info.url}/api/bots`)).json() as any;
  await fetch(`${fixture.info.url}/api/config`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ features: { browser: true } }) });
  await fetch(`${fixture.info.url}/api/bots/${bots[0].id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ browser: true }) });
  ui = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    server: { host: "127.0.0.1", port: 0, proxy: { "/api": { target: fixture.info.url } } },
    plugins: [{ name: "isolated-browser-preview", configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url === "/__browser-test-page") {
          res.setHeader("content-type", "text/html");
          res.end(readFileSync(new URL("./testing/browser-test-page.html", import.meta.url), "utf8"));
          return;
        }
        if (req.url !== "/__browser-preview.html") return next();
        void server.transformIndexHtml(req.url, '<html><head><title>Isolated Browser Preview</title></head><body><div id="root"></div><script type="module" src="/scripts/testing/browser-preview.tsx"></script></body></html>')
          .then((html) => { res.setHeader("content-type", "text/html"); res.end(html); }).catch(next);
      });
    } }],
  });
  await ui.listen();
  console.log(JSON.stringify({ ...fixture.info, botId: bots[0].id, previewUrl: `${ui.resolvedUrls!.local[0]}__browser-preview.html`, testPage: `${ui.resolvedUrls!.local[0]}__browser-test-page` }, null, 2));
  await new Promise<void>((resolve) => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
} finally {
  await ui?.close();
  // close --all is scoped to this fixture's HOME, never the operator's.
  await promisify(execFile)(binaryPath, ["close", "--all"], { env: { HOME: fixture.info.dataDir, USERPROFILE: fixture.info.dataDir, PATH: process.env.PATH }, timeout: 15_000 }).catch(() => {});
  await fixture.close();
}
