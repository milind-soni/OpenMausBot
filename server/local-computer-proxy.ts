// The descriptor and turn token travel in environment variables, never argv or logs.
import { runMcpBridge } from "./mcp-bridge.ts";
import { augmentedPath } from "./env-path.ts";
import { localComputerCallQuery, localComputerRelay, localComputerResultLine } from "./local-computer-guidance.ts";
import { journalUrl } from "./saved-steps/journal-tap.ts";

const {
  OMB_CUA_COMMAND: command,
  OMB_CUA_ARGS: encodedArgs,
  OMB_CUA_PLATFORM: platform,
  OMB_CONTROL_URL: url,
  OMB_CONTROL_TOKEN: token,
  OMB_COMPUTER_JOURNAL: journal,
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

runMcpBridge({
  command: command!,
  args,
  env: { ...childEnv, PATH: augmentedPath() },
  label: "Local Cua Driver",
  gate: { url: url!, token: token!, describe: localComputerCallQuery },
  ...(journal === "1" ? { journal: { url: journalUrl(url!), token: token! } } : {}),
  rewriteResponse: localComputerResultLine,
  relay: localComputerRelay(platform ?? process.platform),
});
