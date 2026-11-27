// The descriptor and turn token travel in environment variables, never argv or logs.
import { homedir } from "node:os";
import { runMcpBridge } from "./mcp-bridge.ts";
import { augmentedPath } from "./env-path.ts";
import { HOST_FILE_TOOLS, hostFileRelay } from "./host-file-tools.ts";
import { localComputerCallQuery, localComputerRelay, localComputerResultLine } from "./local-computer-guidance.ts";
import { journalUrl } from "./saved-steps/journal-tap.ts";
import { COMPUTER_HELPER_STOPPED } from "../shared/your-computer.ts";

const {
  OMB_CUA_COMMAND: command,
  OMB_CUA_ARGS: encodedArgs,
  OMB_CUA_PLATFORM: platform,
  OMB_CONTROL_URL: url,
  OMB_CONTROL_TOKEN: token,
  OMB_COMPUTER_JOURNAL: journal,
  OMB_HOST_FILES: hostFiles,
  ...childEnv
} = process.env;

let args: string[];
try {
  const parsed: unknown = JSON.parse(encodedArgs ?? "");
  const endpoint = new URL(url ?? "");
  if (!command?.trim() || command.includes("\0") ||
      !Array.isArray(parsed) || !parsed.every((arg) => typeof arg === "string" && !arg.includes("\0")) ||
      !token || !["http:", "https:"].includes(endpoint.protocol) ||
      !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) || endpoint.username || endpoint.password) {
    throw new Error("invalid connection");
  }
  args = parsed;
} catch {
  process.stderr.write("invalid local computer proxy connection\n");
  process.exit(2);
}

const screenRelay = localComputerRelay(platform ?? process.platform);
const fileRelay = hostFiles === "1" ? hostFileRelay(homedir()) : null;

runMcpBridge({
  command: command!,
  args,
  env: { ...childEnv, PATH: augmentedPath() },
  label: "Local Cua Driver",
  gate: { url: url!, token: token!, describe: localComputerCallQuery },
  ...(journal === "1" ? { journal: { url: journalUrl(url!), token: token! } } : {}),
  rewriteResponse: localComputerResultLine,
  relay: fileRelay ? (call, child) => fileRelay(call) ?? screenRelay(call, child) : screenRelay,
  ...(fileRelay ? { ownTools: HOST_FILE_TOOLS } : {}),
  respawn: { stopped: COMPUTER_HELPER_STOPPED },
});
