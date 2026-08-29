/* oxlint-disable anti-slop/no-runtime-typeof -- this smoke test validates untrusted HTTP JSON at its boundary. */
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const staging = mkdtempSync(join(tmpdir(), "centipede-v3-packaged-"));
const data = join(staging, "data");
const port = 22000 + Math.floor(Math.random() * 7000);
cpSync(process.env.OMB_SMOKE_DIST ?? join(root, "dist-server"), join(staging, "server"), { recursive: true });

const child = spawn(process.execPath, [join(staging, "server", "v3-index.js")], {
  cwd: staging,
  env: {
    PATH: process.env.PATH ?? "",
    SystemRoot: process.env.SystemRoot ?? "",
    HOME: staging,
    USERPROFILE: staging,
    OMB_PRODUCT_ID: "centipede-v3",
    OMB_PORT: String(port),
    OMB_WEBHOOK_PORT: String(port + 1),
    OMB_DATA_DIR: data,
    OMB_STATIC_DIR: staging,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (chunk) => { output += chunk; });
child.stderr.on("data", (chunk) => { output += chunk; });

const cleanup = () => {
  child.kill("SIGKILL");
  try { rmSync(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* smoke verdict is already determined */ }
};
try {
  const deadline = Date.now() + 45_000;
  let health = null;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) { health = await response.json(); break; }
    } catch { /* server is still booting */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!health || health.app !== "Centipede V3" || health.pid !== child.pid || health.static !== true) {
    throw new Error(`V3 packaged server health mismatch: ${JSON.stringify(health)}\n${output}`);
  }
  const context = await fetch(`http://127.0.0.1:${port}/api/v3/context`);
  if (!context.ok) throw new Error(`V3 context route failed: ${context.status}`);
  const capture = await fetch(`http://127.0.0.1:${port}/api/v3/commands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "capture",
      evidence: {
        captureId: "packaged-smoke",
        source: "packaged-smoke",
        reference: "fixture:packaged-smoke",
        summary: "Packaged V3 routed a provenance-bearing Capture into canonical Work.",
        contentHash: "a".repeat(64),
        confidence: "high",
        criterionIds: ["receipt"],
        artifacts: [{ reference: "fixture:packaged-smoke", kind: "receipt", contentHash: "b".repeat(64) }],
        observedAt: Date.now(),
      },
    }),
  });
  const captured = await capture.json();
  if (!capture.ok || typeof captured?.view?.contract?.outcomeId !== "string") throw new Error(`V3 Capture route failed: ${capture.status} ${JSON.stringify(captured)}`);
  await new Promise((resolve) => setTimeout(resolve, 80));
  const verify = await fetch(`http://127.0.0.1:${port}/api/v3/commands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "verify", outcomeId: captured.view.contract.outcomeId, contractVersion: captured.view.contract.version }),
  });
  const verified = await verify.json();
  if (!verify.ok || verified?.status !== "ok" || verified?.view?.state !== "completed") throw new Error(`V3 verification route failed: ${verify.status} ${JSON.stringify(verified)}`);
  console.log(JSON.stringify({ app: health.app, pid: health.pid, port, contextStatus: context.status, captureStatus: capture.status, verifyStatus: verify.status, outcomeId: captured.view.contract.outcomeId }));
} finally {
  cleanup();
}
