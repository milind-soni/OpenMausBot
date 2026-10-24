import { spawn } from "node:child_process";
import { readFileSync, lstatSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { OfficeDirectiveRequest } from "./office-control.ts";

const configSchema = z.strictObject({
  version: z.literal(1),
  workerId: z.literal("c7fbfb41-e544-4c72-b741-fa12536a290a"),
  controllerHost: z.literal("orch-hel1"),
  host: z.literal("100.103.173.81"),
  port: z.literal(2222),
  user: z.literal("orca"),
  identityFile: z.string().refine(isAbsolute),
  knownHostsFile: z.string().refine(isAbsolute),
});
export type OfficeTransportConfig = z.infer<typeof configSchema>;

function privateFile(path: string): void {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
    throw new Error("Office control files must be private, regular and owned by the worker");
  }
}

export function loadOfficeControlConfig(): OfficeTransportConfig | undefined {
  const path = process.env.OMB_OFFICE_CONTROL_CONFIG;
  if (!path) return undefined;
  if (!isAbsolute(path)) throw new Error("Office control configuration requires an absolute path");
  privateFile(path);
  const config = configSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  privateFile(config.identityFile);
  privateFile(config.knownHostsFile);
  return config;
}

/** The dedicated key permits one fixed controller RPC; it cannot open a shell or forward a port. */
export function createOfficeDirectiveRequester(config: OfficeTransportConfig, launch: typeof spawn = spawn) {
  return (request: OfficeDirectiveRequest, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error("Office controller request was stopped")); return; }
    const child = launch("/usr/bin/ssh", [
      "-F", "/dev/null", "-4", "-T", "-p", String(config.port), "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
      "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "ControlMaster=no",
      "-o", "ControlPath=none", "-o", "UpdateHostKeys=no", "-o", "ConnectTimeout=8",
      "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=1",
      "-o", `UserKnownHostsFile=${config.knownHostsFile}`, "-i", config.identityFile,
      `${config.user}@${config.host}`,
    ], { stdio: ["pipe", "pipe", "pipe"], env: {
      HOME: "/home/orca", USER: "orca", LOGNAME: "orca", LANG: "C.UTF-8", PATH: "/usr/bin:/bin",
    } });
    let settled = false;
    let output = "";
    let killTimer: NodeJS.Timeout | undefined;
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
    const fail = () => {
      if (settled) return;
      settled = true; cleanup(); child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1000); killTimer.unref();
      reject(new Error("Office controller is unavailable or refused this attempt"));
    };
    const abort = () => fail();
    const timer = setTimeout(fail, 20_000); timer.unref();
    signal.addEventListener("abort", abort, { once: true });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (part: string) => {
      output += part;
      if (Buffer.byteLength(output) > 8192) fail();
    });
    child.stderr?.resume();
    child.on("error", fail);
    child.stdin?.on("error", fail);
    child.on("close", code => {
      clearTimeout(killTimer);
      if (settled) return;
      if (code !== 0 || signal.aborted) { fail(); return; }
      try {
        const reply = JSON.parse(output) as { ok?: unknown; attemptId?: unknown };
        if (reply.ok !== true || reply.attemptId !== request.attemptId) { fail(); return; }
      } catch { fail(); return; }
      settled = true; cleanup(); resolve();
    });
    if (signal.aborted) { fail(); return; }
    child.stdin?.end(JSON.stringify(request) + "\n");
  });
}
