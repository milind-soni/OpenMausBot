/* oxlint-disable anti-slop/no-runtime-typeof -- this smoke test validates untrusted HTTP JSON at its boundary. */
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const staging = mkdtempSync(join(tmpdir(), "centipede-v3-coexistence-"));
const v2Data = join(staging, "v2-data");
const v3Data = join(staging, "v3-data");
const dist = join(staging, "server");
cpSync(process.env.OMB_SMOKE_DIST ?? join(root, "dist-server"), dist, { recursive: true });

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("OS did not provide a free TCP port");
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

const [v2Port, v2WebhookPort, v3Port, v3WebhookPort] = await Promise.all([freePort(), freePort(), freePort(), freePort()]);

const baseEnv = {
  PATH: process.env.PATH ?? "",
  SystemRoot: process.env.SystemRoot ?? "",
  HOME: staging,
  USERPROFILE: staging,
  OMB_STATIC_DIR: staging,
};
const v2 = spawn(process.execPath, [join(dist, "index.js")], {
  cwd: staging,
  env: { ...baseEnv, OMB_PRODUCT_ID: "openmausbot", OMB_PORT: String(v2Port), OMB_WEBHOOK_PORT: String(v2WebhookPort), OMB_DATA_DIR: v2Data },
  stdio: ["ignore", "pipe", "pipe"],
});
const v3 = spawn(process.execPath, [join(dist, "v3-index.js")], {
  cwd: staging,
  env: { ...baseEnv, OMB_PRODUCT_ID: "centipede-v3", OMB_PORT: String(v3Port), OMB_WEBHOOK_PORT: String(v3WebhookPort), OMB_DATA_DIR: v3Data },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
for (const child of [v2, v3]) {
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
}

async function health(port, expectedApp, child) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      const body = await response.json();
      if (response.ok && body.app === expectedApp && body.pid === child.pid && body.static === true) return body;
    } catch { /* server is still booting */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`health failed for ${expectedApp}; output:\n${output}`);
}

try {
  const v2Health = await health(v2Port, "openmausbot", v2);
  const v3Health = await health(v3Port, "Centipede V3", v3);
  const v3Context = await fetch(`http://127.0.0.1:${v3Port}/api/v3/context`);
  if (!v3Context.ok) throw new Error(`V3 context endpoint failed: ${v3Context.status}`);
  if (v2.pid === v3.pid || v2Data === v3Data || v2Health.pid === v3Health.pid) throw new Error("V2 and V3 identity collision");
  if (!existsSync(join(v3Data, "work-lock-store.db"))) throw new Error("V3 WorkLock store was not created in the V3 data root");
  if (existsSync(join(v2Data, "work-lock-store.db"))) throw new Error("V2 unexpectedly shared the V3 WorkLock store");
  console.log(JSON.stringify({ v2: { app: v2Health.app, pid: v2Health.pid, port: v2Port, dataRoot: v2Data }, v3: { app: v3Health.app, pid: v3Health.pid, port: v3Port, dataRoot: v3Data, workLock: join(v3Data, "work-lock-store.db") } }));
} finally {
  v2.kill("SIGKILL");
  v3.kill("SIGKILL");
  try { rmSync(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* smoke verdict is already determined */ }
}
