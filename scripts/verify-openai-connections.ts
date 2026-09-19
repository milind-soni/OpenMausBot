// Real connection UI + HTTP server in a disposable home; only a loopback fake API.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { fixtureApi, mountPreview, parkUntilSignal, type MountedPreview } from "./testing/preview-fixture.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = join(root, ".omb-scratch/verify-evidence/openai-connections");
mkdirSync(output, { recursive: true });
const requests: Array<{ path: string; model?: string; authorized: boolean }> = [];
const provider = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const payload = body ? JSON.parse(body) : {};
  requests.push({ path: req.url ?? "", model: payload.model, authorized: Boolean(req.headers.authorization) });
  res.setHeader("content-type", "application/json");
  if (req.url?.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "fixture/shared-model" }] }));
  if (req.url?.endsWith("/chat/completions")) return res.end(JSON.stringify({
    id: "fixture-response", choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
  }));
  res.writeHead(404).end(JSON.stringify({ error: { message: "Unknown fixture route" } }));
});
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
const providerBase = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;
let fixture: Awaited<ReturnType<typeof launchVerificationServer>> | undefined;
let preview: MountedPreview | undefined;
try {
  fixture = await launchVerificationServer();
  await fixtureApi(fixture.info.url)("PATCH", "/api/config", { language: "en" });
  await runControlOmb(["new-bot", "--name", "Connection Scout", "--url", fixture.info.url]);
  preview = await mountPreview(fixture, { entry: "/src/testing/openai-connections.tsx", route: "/__openai-connections.html", title: "OpenAI connections — isolated verification", logLevel: "error" });
  if (process.argv.includes("--interactive")) {
    console.log(JSON.stringify({ ...fixture.info, providerBase, previewUrl: preview.previewUrl }));
    await parkUntilSignal();
  } else {
    const electron = process.env.OMB_VERIFY_ELECTRON ?? createRequire(import.meta.url)("electron");
    const child = spawn(electron, [join(root, "scripts/testing/openai-connections-driver.mjs"), preview.previewUrl, output, providerBase], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "" }, stdio: "inherit", timeout: 300_000,
    });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (code === 0) return resolve();
        const reason = child.killed ? `timed out after 300 seconds (${signal ?? "terminated"})`
          : signal ? `terminated by ${signal}` : `exit code ${code}`;
        reject(new Error(`Connection UI verification failed: ${reason}`));
      });
    });
    writeFileSync(join(output, "requests.json"), `${JSON.stringify(requests, null, 2)}\n`);
    writeFileSync(join(output, "server-log.txt"), `${fixture.info.logPath}\n`);
    console.log(JSON.stringify({ ok: true, evidence: output, requests: requests.length }));
  }
} finally {
  await preview?.close();
  await fixture?.close();
  await new Promise<void>((resolve) => { provider.close(() => resolve()); provider.closeAllConnections(); });
}
