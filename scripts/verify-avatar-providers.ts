// Real avatar UI and server, with a loopback-only fake Images API. No paid calls.
import { createServer as createHttpServer } from "node:http";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { mountPreview, parkUntilSignal, type MountedPreview } from "./testing/preview-fixture.ts";

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
let ui: MountedPreview | undefined;
try {
  fixture = await launchVerificationServer();
  await runControlOmb(["new-bot", "--name", "Avatar Scout", "--url", fixture.info.url]);
  ui = await mountPreview(fixture, {
    entry: "/src/testing/avatar-providers.tsx", route: "/__avatar-providers.html", title: "Avatar providers — isolated fixture",
    extraRoutes: [{
      path: "/__fixture/requests",
      handler(_req, res) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(requests)); },
    }],
  });
  console.log(JSON.stringify({ ...fixture.info, imageBase, previewUrl: `${ui.previewUrl}?base=${encodeURIComponent(imageBase)}` }));
  await parkUntilSignal();
} finally {
  await ui?.close();
  await fixture?.close();
  await new Promise<void>((resolve) => imageApi.close(() => resolve()));
}
