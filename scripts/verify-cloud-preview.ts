// Real ComputerPanel + isolated fake-engine server, with only its cloud
// transport simulated. No Box account or user's app data is contacted.
// Run: node --experimental-strip-types scripts/verify-cloud-preview.ts
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = await launchVerificationServer();
let ui: Awaited<ReturnType<typeof createServer>> | undefined;
const close = async () => {
  await ui?.close();
  await fixture.close();
};
try {
  await runControlOmb(["new-bot", "--name", "Box Preview Test", "--url", fixture.info.url]);
  ui = await createServer({
    root,
    server: { host: "127.0.0.1", port: 0, proxy: { "/api": { target: fixture.info.url } } },
    plugins: [{
      name: "isolated-cloud-preview",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url !== "/__cloud-preview.html") return next();
          void server.transformIndexHtml(req.url, '<html><head><title>Isolated Box Preview Test</title></head><body><div id="root"></div><script type="module" src="/scripts/testing/cloud-preview.tsx"></script></body></html>')
            .then((html) => { res.setHeader("content-type", "text/html"); res.end(html); })
            .catch(next);
        });
      },
    }],
  });
  await ui.listen();
  console.log(JSON.stringify({ ...fixture.info, previewUrl: `${ui.resolvedUrls!.local[0]}__cloud-preview.html` }, null, 2));
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
} finally {
  await close();
}
