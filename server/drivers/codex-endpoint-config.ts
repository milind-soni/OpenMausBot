/** A Responses endpoint used by an isolated Codex instance. */
export interface CodexEndpointConfig {
  url: string;
  models: string[];
}

export function decodeRoutedCodexConfig(raw: object, label = "Company"): CodexEndpointConfig {
  const value = raw as { url?: unknown; models?: unknown };
  if (typeof value.url !== "string" || !Array.isArray(value.models) || !value.models.length || value.models.some(model => typeof model !== "string" || !/^[\w][\w./+-]*$/.test(model))) {
    throw new Error(`Invalid ${label} Codex configuration.`);
  }
  const url = new URL(value.url);
  // Plain HTTP leaks the API key; allow it only on loopback.
  const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) throw new Error(`Invalid ${label} Codex endpoint.`);
  return { url: url.href.replace(/\/$/, ""), models: value.models as string[] };
}

export function managedCodexArgs(config: CodexEndpointConfig): string[] {
  return providerCodexArgs(config.url, "openmaus_company", "Company", "OPENMAUSBOT_COMPANY_API_KEY");
}

export function endpointCodexArgs(config: CodexEndpointConfig): string[] {
  return [...providerCodexArgs(config.url, "openmaus_endpoint", "Direct API", "OPENMAUSBOT_CODEX_API_KEY"),
    "-c", "model_providers.openmaus_endpoint.supports_websockets=false",
    "-c", "features.tool_search=false"];
}

function providerCodexArgs(url: string, provider: string, name: string, key: string): string[] {
  return [
    "-c", `model_provider=${JSON.stringify(provider)}`,
    "-c", `model_providers.${provider}.name=${JSON.stringify(name)}`,
    "-c", `model_providers.${provider}.base_url=${JSON.stringify(url)}`,
    "-c", `model_providers.${provider}.env_key=${JSON.stringify(key)}`,
    "-c", `model_providers.${provider}.wire_api="responses"`,
    "-c", `model_providers.${provider}.requires_openai_auth=false`,
    "-c", 'cli_auth_credentials_store="ephemeral"',
    "-c", "shell_environment_policy.ignore_default_excludes=false",
  ];
}

