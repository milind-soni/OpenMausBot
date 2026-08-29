import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const port = Number(process.argv[2] ?? 29741);
const output = resolve(process.argv[3] ?? "artifacts/centipede-0.2.0/journeys/browser/edge");
const requestsFile = resolve(output, "network.ndjson");
await mkdir(dirname(requestsFile), { recursive: true });
await writeFile(requestsFile, "", "utf8");

const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Agent Centipede Edge Proof</title>
<style>body{font:16px Inter,system-ui;background:#f5f7ef;color:#18220b;margin:0;padding:48px}main{max-width:680px;margin:auto;background:white;border:1px solid #cbd7b9;border-radius:24px;padding:36px;box-shadow:0 18px 50px #26380d18}button{background:#789d00;color:white;border:0;border-radius:999px;padding:14px 22px;font-weight:700}#status{margin-top:22px;padding:14px;background:#eef5dc;border-radius:12px}</style></head>
<body><main data-proof="edge-001"><p>AGENT CENTIPEDE · ISOLATED FIXTURE</p><h1>Edge workflow proof</h1><p>This page is local, synthetic, and makes no external requests.</p><button data-testid="execute-workflow">Run verified workflow</button><div id="status" role="status">Ready</div></main>
<script>
fetch('/api/context').then(r=>r.json()).then(v=>document.body.dataset.context=v.context);
document.querySelector('[data-testid="execute-workflow"]').addEventListener('click', async () => {
  const response = await fetch('/api/execute', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({fixture:'edge-001',action:'verify'})});
  const result = await response.json();
  document.querySelector('#status').textContent = 'Verified: ' + result.receipt;
  document.querySelector('#status').dataset.verified = 'true';
});
</script></body></html>`;

async function record(request, body = "") {
  const entry = {
    at: new Date().toISOString(),
    method: request.method,
    path: request.url,
    bodySha256: createHash("sha256").update(body).digest("hex"),
    bodyBytes: Buffer.byteLength(body),
  };
  await appendFile(requestsFile, `${JSON.stringify(entry)}\n`, "utf8");
}

const server = createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", async () => {
    const body = Buffer.concat(chunks).toString("utf8");
    await record(request, body);
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(html);
      return;
    }
    if (request.method === "GET" && request.url === "/api/context") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ context: "local-only" }));
      return;
    }
    if (request.method === "POST" && request.url === "/api/execute") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ receipt: "edge-001" }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });
});

server.listen(port, "127.0.0.1", async () => {
  const state = { pid: process.pid, url: `http://127.0.0.1:${port}/`, requestsFile: "network.ndjson" };
  await writeFile(resolve(output, "server.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(state)}\n`);
});

const stop = () => server.close(() => process.exit(0));
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
