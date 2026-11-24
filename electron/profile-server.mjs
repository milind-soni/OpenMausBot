import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import path from "node:path";
import { acquireDataDirLease } from "./data-dir-lease.mjs";
import { pollServerIdentity, SERVER_BOOT_TIMEOUT_MS } from "./server-boot-probe.mjs";
import { reportOwnListeners, reserveProfilePort } from "./server-session.mjs";
import { serverChildLaunch, stopOwnedChild } from "./server-child-launch.mjs";

async function availablePort() {
  const listener = createServer();
  await new Promise((resolve, reject) => listener.once("error", reject).listen(0, "127.0.0.1", resolve));
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}

export async function startProfileServer({ dir, resourcesPath, userData, env, fork, prepare, onStarted, onExit, signal, log }) {
  const lease = acquireDataDirLease(dir);
  let reservation;
  let child;
  let exited = false;
  let stopped;
  let stopping;
  const stop = () => {
    if (!child || exited) return;
    stopping ??= stopOwnedChild(child, stopped).then(ok => {
      if (!ok) log("Workspace server is still stopping. Its data folder remains in use.");
    });
    return stopping;
  };
  try {
    prepare();
    const port = await availablePort();
    signal.throwIfAborted();
    reservation = reserveProfilePort(port);
    const token = randomBytes(32).toString("base64url");
    const { entry, compileCacheDir } = serverChildLaunch({ resourcesPath, userData });
    const childEnv = {
      ...env, ...lease.utilityServerLeaseEnvironment(), OMB_DESKTOP_PARENT: "1",
      OMB_DATA_DIR: dir, OMB_PORT: String(port), OMB_WEBHOOK_PORT: "0",
      OMB_STATIC_DIR: path.join(resourcesPath, "ui"), OMB_RESOURCES_PATH: resourcesPath,
      OMB_SKILLS_DIR: path.join(resourcesPath, "skills"), OMB_USER_DATA: userData,
    };
    delete childEnv.OMB_SERVER_COMPILE_CACHE;
    delete childEnv.OMB_BROWSER_CONNECTION;
    delete childEnv.OMB_TEST_COOKIE_KEY;
    delete childEnv.OMB_WEBHOOK_SOCKET;
    delete childEnv.OMB_WEBHOOK_PUBLIC_URL;
    if (compileCacheDir) childEnv.OMB_SERVER_COMPILE_CACHE = compileCacheDir;
    child = fork(entry, [], { env: childEnv, stdio: "pipe" });
    child.stdout?.on("data", chunk => log(String(chunk).trimEnd()));
    child.stderr?.on("data", chunk => log(String(chunk).trimEnd()));
    stopped = new Promise(resolve => child.once("exit", () => {
      exited = true;
      signal.removeEventListener("abort", stop);
      reservation.release();
      try { lease.release(); } catch (error) { log(error.message); }
      resolve();
      onExit();
    }));
    onStarted(stopped);
    signal.addEventListener("abort", stop, { once: true });
    child.once("spawn", () => child.postMessage({ type: "openmausbot:desktop-mutation-token", token, companionToken: randomBytes(32).toString("base64url") }));
    const identity = await pollServerIdentity({ port, pid: () => child.pid, bootTimeoutMs: SERVER_BOOT_TIMEOUT_MS, isExited: () => exited || signal.aborted });
    if (identity.outcome !== "ready" || exited || signal.aborted) throw new Error("The workspace server could not start.");
    reportOwnListeners(child, [port]);
    return { allowSession: reservation.allow, origin: `http://127.0.0.1:${port}`, token };
  } catch (error) {
    if (!child) { reservation?.release(); lease.release(); }
    else await stop();
    throw error;
  }
}
