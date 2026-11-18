// A ChatGPT plan run's sign-in, renewed while Codex works: Codex asks its `auth.command` for a token whenever it needs
// one, and that command reads the current token from a local bridge only this run holds the secret for.
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { startChatGptTokenBridge } from "./chatgpt-plan-token-bridge.ts";

/** What a bridged run adds to Codex's environment; none of it may reach the agent's shell. */
export const PLAN_TOKEN_BRIDGE_ENV = ["OMB_CODEX_AUTH_SOCKET", "OMB_CODEX_AUTH_SECRET", "ELECTRON_RUN_AS_NODE"];

export interface PlanTokenBridge {
  env: Record<string, string>;
  close(): void;
}

/** The token-sharing Responses bridge carries no hosted tool_search (Codex 0.159.0 sends none), so
 * a plan turn's MCP tools load up front. `renewing` hands Codex the token command in place of a fixed token. */
export function chatgptPlanCodexArgs(renewing = false): string[] {
  return [
    "-c", 'model_provider="openai_chatgpt_plan"',
    "-c", 'model_providers.openai_chatgpt_plan.name="ChatGPT plan"',
    "-c", 'model_providers.openai_chatgpt_plan.base_url="https://api.openai.com/v1"',
    ...(renewing ? [
      "-c", `model_providers.openai_chatgpt_plan.auth.command=${JSON.stringify(process.execPath)}`,
      "-c", `model_providers.openai_chatgpt_plan.auth.args=[${JSON.stringify(SPAWNED_PROXIES.chatgptPlanToken)}]`,
      "-c", "model_providers.openai_chatgpt_plan.auth.refresh_interval_ms=30000",
      "-c", "model_providers.openai_chatgpt_plan.auth.timeout_ms=60000",
    ] : ["-c", 'model_providers.openai_chatgpt_plan.env_key="OPENMAUSBOT_CHATGPT_TOKEN"']),
    "-c", 'model_providers.openai_chatgpt_plan.wire_api="responses"',
    "-c", "model_providers.openai_chatgpt_plan.requires_openai_auth=false",
    "-c", "model_providers.openai_chatgpt_plan.supports_websockets=false",
    "-c", 'cli_auth_credentials_store="ephemeral"',
    "-c", "features.tool_search=false",
    "-c", "shell_environment_policy.ignore_default_excludes=false",
    // OPENMAUSBOT_CHATGPT_TOKEN is excluded via extendShellExclusions: a `-c exclude` here would replace the lower layers' list.
  ];
}

const renewsToken = (version: string) => {
  const match = version.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  return !!match && (Number(match[1]) > 0 || Number(match[2]) >= 165);
};

/** Whether this driver's Codex (0.165.0 or later) can renew the token through `auth.command`. The answer is kept
 * until a snapshot reads another version, after an update, so a turn does not wait on `codex --version` each time.
 * A failed read is not kept: the next turn asks again. */
export function planTokenRenewal(readVersion: () => Promise<{ version: string } | { reason: string }>) {
  let known: boolean | undefined;
  let pending: Promise<boolean> | undefined;
  return {
    supported(): Promise<boolean> {
      if (known !== undefined) return Promise.resolve(known);
      pending ??= readVersion().then((probe) => "version" in probe ? (known = renewsToken(probe.version)) : false)
        .finally(() => { pending = undefined; });
      return pending;
    },
    /** Records the version a snapshot just read and answers whether it renews. */
    noteVersion(version: string): boolean {
      return (known = renewsToken(version));
    },
  };
}

/** `stillCurrent` throws once the account changed or the task ended; it runs before and after every token read. */
export async function startPlanTokenBridge(accessToken: () => Promise<string>, stillCurrent: () => void): Promise<PlanTokenBridge> {
  const bridge = await startChatGptTokenBridge(async () => {
    stillCurrent();
    const token = await accessToken();
    stillCurrent();
    return token;
  });
  try {
    stillCurrent();
  } catch (error) {
    bridge.close();
    throw error;
  }
  // The token command runs on this app's own runtime, which in the desktop app is Electron.
  return { env: { ...bridge.env, ELECTRON_RUN_AS_NODE: "1" }, close: () => bridge.close() };
}
