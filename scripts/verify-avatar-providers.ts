// Real avatar UI and server, with a loopback-only fake Images API. No paid calls.
import { createServer as createHttpServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const requests: Array<{ path: string; model?: string; authorized: boolean }> = [];
const imageApi = createHttpServer(async (req, res) => {
  try {
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 32_768) { res.writeHead(413).end(); return; }
    }
    const parsed = JSON.parse(body);
    requests.push({ path: req.url ?? "", model: parsed.model, authorized: Boolean(req.headers.authorization) });
    res.setHeader("content-type", "application/json");
    if (req.url?.startsWith("/error/")) {
      res.writeHead(401).end(JSON.stringify({ error: { message: `DO_NOT_ECHO ${req.headers.authorization}` } }));
    } else if (req.url?.startsWith("/url-only/")) {
      res.end(JSON.stringify({ data: [{ url: "http://169.254.169.254/latest/meta-data/" }] }));
    } else {
      res.end(JSON.stringify({ data: [{ b64_json: png }] }));
    }
  } catch { res.writeHead(400).end(); }
});
await new Promise<void>((resolve) => imageApi.listen(0, "127.0.0.1", resolve));
const imagePort = (imageApi.address() as { port: number }).port;
const imageBase = `http://127.0.0.1:${imagePort}/v1`;
let fixture: Awaited<ReturnType<typeof launchVerificationServer>> | undefined;
let ui: Awaited<ReturnType<typeof createServer>> | undefined;
try {
  fixture = await launchVerificationServer();
  await runControlOmb(["new-bot", "--name", "Avatar Scout", "--url", fixture.info.url]);
  ui = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    server: { host: "127.0.0.1", port: 0, proxy: { "/api": { target: fixture.info.url } } },
    plugins: [{ name: "avatar-provider-fixture", configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split("?")[0] === "/__avatar-providers.html") {
          void server.transformIndexHtml(req.url, '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Avatar providers — isolated fixture</title></head><body><div id="root"></div><script type="module" src="/src/testing/avatar-providers.tsx"></script></body></html>')
            .then((html) => { res.setHeader("content-type", "text/html"); res.end(html); }).catch(next);
          return;
        }
        if (req.url === "/__fixture/requests") {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(requests));
          return;
        }
        next();
      });
    } }],
  });
  await ui.listen();
  console.log(JSON.stringify({ ...fixture.info, imageBase, previewUrl: `${ui.resolvedUrls!.local[0]}__avatar-providers.html?base=${encodeURIComponent(imageBase)}` }));
  await new Promise<void>((resolve) => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
} finally {
  await ui?.close();
  await fixture?.close();
  await new Promise<void>((resolve) => imageApi.close(() => resolve()));
}
