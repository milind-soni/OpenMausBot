// Transparent stdio bridge to the official CUA Driver in a remote worker's
// interactive session. Authentication is owned by the operator's OpenSSH
// config; the only remote command is the pinned CUA MCP invocation, and the
// child environment is the allow-list from ./remote-worker.ts rather than
// this process's own environment.
import { isWorkerPlatform, type WorkerPlatform } from "./computer-workers.ts";
import { runMcpBridge } from "./mcp-bridge.ts";
import {
  remoteWorkerCuaMcpSshArgs,
  remoteWorkerSshBaseArgs,
  remoteWorkerSshEnvironment,
} from "./remote-worker.ts";

const [alias = "", channelPath = "", rawPlatform = ""] = process.argv.slice(2);

/** A no-op that exits 0 through each platform's default SSH shell. Windows
 * OpenSSH hands the command to cmd.exe, which has no `true`. */
function livenessCommand(platform: WorkerPlatform): string[] {
  return platform === "windows"
    ? ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"]
    : ["/bin/sh", "-c", "exit 0"];
}

let args: string[];
let livenessArgs: string[];
try {
  if (!isWorkerPlatform(rawPlatform)) throw new Error("unknown worker platform");
  args = remoteWorkerCuaMcpSshArgs(alias, channelPath);
  livenessArgs = [...remoteWorkerSshBaseArgs(alias), ...livenessCommand(rawPlatform)];
} catch {
  process.stderr.write("invalid worker MCP connection\n");
  process.exit(2);
}

const gate = (() => {
  const url = process.env.OMB_CONTROL_URL ?? "";
  const token = process.env.OMB_CONTROL_TOKEN ?? "";
  return url && token ? { gate: { url, token } } : {};
})();
// The task tools ride the same MCP server as the CUA tools they unlock, so a
// bot never holds a bounded worker with no way to propose the task that would
// unbind it.
const task = (() => {
  const url = process.env.OMB_TASK_URL ?? "";
  const secret = process.env.OMB_TASK_TOKEN ?? "";
  return url && secret ? { task: { url, token: secret } } : {};
})();
// Note which environment the ssh child gets: the allow-list below, which
// carries neither loopback secret. Both stay in this process, where the two
// interceptors use them, and never cross to the worker.
const sshEnv = remoteWorkerSshEnvironment();

runMcpBridge({
  command: "ssh",
  args,
  env: sshEnv,
  label: "Worker CUA Driver",
  liveness: { command: "ssh", args: livenessArgs, env: sshEnv },
  ...gate,
  ...task,
});
