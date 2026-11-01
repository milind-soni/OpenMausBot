import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import type { CodexConfig } from "./codex.ts";
import type { execCli } from "../procs.ts";

/** The token-sharing Responses bridge carries no hosted tool_search (Codex 0.159.0 sends none), so
 * a plan turn's MCP tools load up front. */
export function chatgptPlanCodexArgs(dynamic = false): string[] {
  return [
    "-c", 'model_provider="openai_chatgpt_plan"',
    "-c", 'model_providers.openai_chatgpt_plan.name="ChatGPT plan"',
    "-c", 'model_providers.openai_chatgpt_plan.base_url="https://api.openai.com/v1"',
    ...(dynamic ? [
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

export function decodeManagedCodex(raw: object): NonNullable<CodexConfig["managed"]> {
  const value = raw as { url?: unknown; models?: unknown };
  if (typeof value.url !== "string" || !Array.isArray(value.models) || !value.models.length || value.models.some(model => typeof model !== "string" || !/^[\w][\w./+-]*$/.test(model))) {
    throw new Error("Invalid Company Codex configuration.");
  }
  const url = new URL(value.url);
  // Plain HTTP leaks the Company API key; allow it only on loopback.
  const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) throw new Error("Invalid Company Codex endpoint.");
  return { url: url.href.replace(/\/$/, ""), models: value.models as string[] };
}

export function managedCodexArgs(config: NonNullable<CodexConfig["managed"]>): string[] {
  // Credential stays in the instance environment, never argv or config.toml.
  // https://learn.chatgpt.com/docs/config-file/config-reference
  return [
    "-c", 'model_provider="openmaus_company"',
    "-c", 'model_providers.openmaus_company.name="Company"',
    "-c", `model_providers.openmaus_company.base_url=${JSON.stringify(config.url)}`,
    "-c", 'model_providers.openmaus_company.env_key="OPENMAUSBOT_COMPANY_API_KEY"',
    "-c", 'model_providers.openmaus_company.wire_api="responses"',
    "-c", "model_providers.openmaus_company.requires_openai_auth=false",
    "-c", 'cli_auth_credentials_store="ephemeral"',
    "-c", "shell_environment_policy.ignore_default_excludes=false",
  ];
}

export function createDynamicPlanSupport(cli: string, env: Record<string, string | undefined>, exec: typeof execCli) {
  let pending: Promise<boolean> | undefined;
  return () => {
    if (pending) return pending;
    pending = new Promise<boolean>((resolve) => {
      exec(cli, ["--version"], { timeout: 8000, env }, (error, stdout) => {
        const match = error ? null : stdout.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
        resolve(!!match && (Number(match[1]) > 0 || Number(match[2]) >= 165));
      });
    }).finally(() => { pending = undefined; });
    return pending;
  };
}
