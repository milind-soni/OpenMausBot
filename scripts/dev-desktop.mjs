import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const viteBin = path.join(rootDir, "node_modules", "vite", "bin", "vite.js");
const serverScript = path.join(rootDir, "server", "index.ts");

const VITE_PORT = 5199;
const SERVER_PORT = Number(process.env.GBS_PORT) || 8899;

function checkHarness(port, timeoutMs = 600) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return resolve(false);
      }
      let raw = "";
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => {
        try {
          const body = JSON.parse(raw);
          resolve(body?.app === "gerer-build-studio");
        } catch {
          resolve(false);
        }
      });
    });
    req.on("error", () => resolve(false));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function checkUrl(url, timeoutMs = 600) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode !== undefined && res.statusCode < 500);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForHarness(port, maxWaitMs = 30000, intervalMs = 250) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const ok = await checkHarness(port);
    if (ok) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

async function waitForUrl(url, maxWaitMs = 30000, intervalMs = 250) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const ok = await checkUrl(url);
    if (ok) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

const spawnedChildren = [];

function cleanUp() {
  for (const child of spawnedChildren) {
    if (!child.killed) {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }
  }
}

process.on("exit", cleanUp);
process.on("SIGINT", () => {
  cleanUp();
  process.exit(0);
});
process.on("SIGTERM", () => {
  cleanUp();
  process.exit(0);
});

async function main() {
  const isServerUp = await checkHarness(SERVER_PORT);
  if (!isServerUp) {
    console.log(`[dev:desktop] Starting harness server on port ${SERVER_PORT}...`);
    const serverProc = spawn(process.execPath, ["--experimental-strip-types", serverScript], {
      cwd: rootDir,
      stdio: "inherit",
      env: { ...process.env, GBS_PORT: String(SERVER_PORT) },
    });
    serverProc.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        console.error(`[dev:desktop] Harness server exited with code ${code}.`);
      }
    });
    spawnedChildren.push(serverProc);
  } else {
    console.log(`[dev:desktop] Harness server already running on port ${SERVER_PORT}.`);
  }

  console.log(`[dev:desktop] Waiting for harness server to become ready on port ${SERVER_PORT}...`);
  const serverReady = await waitForHarness(SERVER_PORT);
  if (!serverReady) {
    console.error(`[dev:desktop] Timed out waiting for harness server at http://127.0.0.1:${SERVER_PORT}/`);
    cleanUp();
    process.exit(1);
  }

  const isViteUp = await checkUrl(`http://127.0.0.1:${VITE_PORT}/`);
  if (!isViteUp) {
    console.log(`[dev:desktop] Starting Vite frontend dev server on port ${VITE_PORT}...`);
    const viteProc = spawn(process.execPath, [viteBin], {
      cwd: rootDir,
      stdio: "inherit",
      env: process.env,
    });
    spawnedChildren.push(viteProc);
  } else {
    console.log(`[dev:desktop] Vite frontend dev server already running on port ${VITE_PORT}.`);
  }

  console.log("[dev:desktop] Waiting for Vite dev server to become ready...");
  const ready = await waitForUrl(`http://127.0.0.1:${VITE_PORT}/`);
  if (!ready) {
    console.error("[dev:desktop] Timed out waiting for Vite dev server at http://127.0.0.1:5199/");
    cleanUp();
    process.exit(1);
  }

  if (process.argv.includes("--web")) {
    console.log(`[dev:web] Studio is running at http://127.0.0.1:${VITE_PORT}/ (API on port ${SERVER_PORT}). Press Ctrl+C to stop both.`);
    return;
  }

  console.log("[dev:desktop] Launching Electron desktop shell...");
  const electronProc = spawn(electronPath, ["."], {
    cwd: rootDir,
    stdio: "inherit",
    env: process.env,
  });

  electronProc.on("exit", (code) => {
    cleanUp();
    process.exit(code ?? 0);
  });
}

main().catch((err) => {
  console.error("[dev:desktop] Failed to start:", err);
  cleanUp();
  process.exit(1);
});
