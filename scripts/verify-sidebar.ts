// Actual Sidebar against a disposable fake-engine server; never the live app.
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";

const fixture = await launchVerificationServer();
let ui: Awaited<ReturnType<typeof createServer>> | undefined;
try {
  for (const name of ["Sidebar Atlas", "Sidebar Juniper"]) {
    await runControlOmb(["new-bot", "--name", name, "--url", fixture.info.url]);
  }
  ui = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    server: { host: "127.0.0.1", port: 0, proxy: { "/api": { target: fixture.info.url } } },
    plugins: [{ name: "isolated-sidebar-preview", configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url !== "/__sidebar-preview.html") return next();
        void server.transformIndexHtml(req.url, '<html><head><title>Isolated Sidebar Test</title></head><body><div id="root"></div><script type="module" src="/scripts/testing/sidebar-preview.tsx"></script></body></html>')
          .then((html) => { res.setHeader("content-type", "text/html"); res.end(html); }).catch(next);
      });
    } }],
  });
  await ui.listen();
  console.log(JSON.stringify({ ...fixture.info, previewUrl: `${ui.resolvedUrls!.local[0]}__sidebar-preview.html` }));
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
} finally {
  await ui?.close();
  await fixture.close();
}
