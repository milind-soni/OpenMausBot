import { spawn, execFileSync, spawnSync } from "node:child_process";
import { once } from "node:events";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { makeTestTls } from "../server/testing/test-tls.ts";

const require = createRequire(import.meta.url);
const home = mkdtempSync(join(tmpdir(), "omb-proxy-smoke-"));
let child;
let timer;
const cancel = () => child?.kill();
process.on("SIGINT", cancel);
process.on("SIGTERM", cancel);
try {
  if (!makeTestTls(home)) throw new Error("openssl is required for the native HTTPS proxy fixture");
  let executable = require("electron");
  if (process.platform === "win32" && spawnSync(executable, ["--version"], { timeout: 10000, windowsHide: true }).status !== 0) {
    const runtime = join(home, "runtime");
    cpSync(dirname(executable), runtime, { recursive: true });
    execFileSync("icacls.exe", [runtime, "/grant", "*S-1-15-2-1:(OI)(CI)(RX)", "/T", "/Q"], { windowsHide: true, stdio: "pipe" });
    executable = join(runtime, "electron.exe");
    console.log(JSON.stringify({ runtime: "isolated-copy", sandbox: true }));
  }
  child = spawn(executable, ["scripts/smoke-system-proxy.mjs"], {
    stdio: ["ignore", "pipe", "inherit"], windowsHide: true, env: { ...process.env, OMB_PROXY_SMOKE_HOME: join(home, "profile"), OMB_PROXY_SMOKE_TLS: home },
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; process.stdout.write(chunk); });
  timer = setTimeout(() => { console.error("Electron proxy smoke timed out"); child.kill(); }, 90000);
  const [code] = await once(child, "exit");
  if (code !== 0) throw new Error(`Electron proxy smoke exited with status ${code}`);
  if (!output.split(/\r?\n/).some(line => { try { return JSON.parse(line).ok === true; } catch { return false; } })) throw new Error("Electron exited before completing the proxy verification");
} finally {
  clearTimeout(timer);
  process.off("SIGINT", cancel);
  process.off("SIGTERM", cancel);
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
