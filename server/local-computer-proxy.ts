// Near-side gate for the host CUA process. The descriptor and turn token
// travel in environment variables, never command-line arguments or logs.
import { runMcpBridge } from "./mcp-bridge.ts";
import { augmentedPath } from "./env-path.ts";

const {
  OMB_CUA_COMMAND: command,
  OMB_CUA_ARGS: encodedArgs,
  OMB_CONTROL_URL: url,
  OMB_CONTROL_TOKEN: token,
  OMB_DECISION_PROVIDER: decisionProvider,
  OMB_DECISION_URL: decisionUrl,
  OMB_DECISION_API_KEY: decisionApiKey,
  OMB_DECISION_MODEL: decisionModel,
  OMB_DECISION_THRESHOLD: decisionThreshold,
  OMB_DECISION_FLOW: decisionFlow,
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

// The chooser is opt-in by env (#1630): the harness passes these values
// only for a configured, probe-calibrated connection, and they are
// revalidated here so a stray or malformed env never half-enables it.
const decisionThresholdValue = Number(decisionThreshold);
const decision =
  decisionProvider && decisionModel && decisionFlow &&
  typeof decisionUrl === "string" && /^https?:\/\//i.test(decisionUrl) &&
  !decisionProvider.includes("\0") && !decisionModel.includes("\0") &&
  Number.isFinite(decisionThresholdValue) && decisionThresholdValue >= 0.5 && decisionThresholdValue <= 1
    ? {
        provider: decisionProvider,
        url: decisionUrl,
        model: decisionModel,
        threshold: decisionThresholdValue,
        flow: decisionFlow,
        ...(decisionApiKey ? { apiKey: decisionApiKey } : {}),
      }
    : undefined;

runMcpBridge({
  command: command!,
  args,
  env: { ...childEnv, PATH: augmentedPath() },
  label: "Local Cua Driver",
  gate: { url: url!, token: token! },
  ...(decision ? { decision } : {}),
});
