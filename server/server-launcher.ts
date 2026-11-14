// Container entry: restarts the server in place on RESTART_EXIT_CODE, so a restart the server asks for keeps the container.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { boxMemory, heapSizeArgs, type BoxMemory } from "./box-memory.ts";
import { clearRecordsFromEarlierRunOfThisContainer } from "./data-dir-lease.ts";
import { restartPolicy } from "./restart.ts";

/** The server's heap sized to the container's memory limit, run through the bootstrap that keeps Node's compile cache on
 * the data volume, so a restarted container reuses the compiled bundle. */
export function serverCommand(here: string, env: NodeJS.ProcessEnv, options: { exists?: (path: string) => boolean; box?: BoxMemory } = {}) {
  const bootstrap = join(here, "desktop-entry.mjs");
  const cached = (options.exists ?? existsSync)(bootstrap);
  const dataDir = env.OMB_DATA_DIR || join(homedir(), ".openmausbot");
  return {
    args: [...heapSizeArgs((options.box ?? boxMemory()).cgroupLimit, env.NODE_OPTIONS), cached ? bootstrap : join(here, "index.js")],
    env: cached ? { ...env, OMB_SERVER_COMPILE_CACHE: join(dataDir, "cache", "node-compile") } : env,
  };
}

export function superviseServer(start: () => ChildProcess, options: { signals?: Pick<NodeJS.Process, "on" | "off">; now?: () => number } = {}): Promise<number> {
  const signals = options.signals ?? process, now = options.now ?? Date.now;
  return new Promise((done) => {
    let child: ChildProcess, stopping = false;
    const policy = restartPolicy(now);
    const pass = (signal: NodeJS.Signals) => () => { stopping = true; child.kill(signal); };
    const onTerm = pass("SIGTERM"), onInt = pass("SIGINT");
    const finish = (code: number) => { signals.off("SIGTERM", onTerm); signals.off("SIGINT", onInt); done(code); };
    const run = () => {
      child = start();
      child.once("error", () => finish(1));
      child.once("exit", (code, signal) => {
        if (policy.again(code, stopping)) {
          console.log("OpenMausBot is starting again to finish installing a copy from the desktop app…");
          run();
          return;
        }
        finish(code ?? (stopping && (signal === "SIGTERM" || signal === "SIGINT") ? 0 : 1));
      });
    };
    signals.on("SIGTERM", onTerm);
    signals.on("SIGINT", onInt);
    run();
  });
}

/** Node names the entry by its real path, so compare real paths (a macOS temp folder is reached through a link). */
function isEntry(): boolean {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]!))).href; } catch { return false; }
}

if (isEntry()) {
  const dataDir = process.env.OMB_DATA_DIR || join(homedir(), ".openmausbot");
  try {
    // A container starts with nothing of its own running: a lease its earlier run left is a dead server's.
    for (const { path, pid } of clearRecordsFromEarlierRunOfThisContainer(dataDir)) console.log(`Removed ${path}, left by this container's server (process ${pid}) when it stopped without closing.`);
  } catch (error) {
    console.warn(`The data folder's lease could not be checked: ${error instanceof Error ? error.message : String(error)}`);
  }
  const server = serverCommand(dirname(fileURLToPath(import.meta.url)), process.env);
  void superviseServer(() => spawn(process.execPath, server.args, { stdio: "inherit", env: server.env })).then((code) => { process.exitCode = code; });
}
