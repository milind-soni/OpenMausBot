// CodexConfig and its decoding, plus the managed Company routing args.
export interface CodexConfig {
  cli: string;
  fullAuto: boolean;
  /** Ephemeral Company routing, supplied by the trusted desktop parent. */
  managed?: { url: string; models: string[] };
}

export function decodeConfig(raw: unknown): CodexConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    cli: typeof o.cli === "string" ? o.cli : "codex",
    fullAuto: o.fullAuto === true,
    ...(o.managed && typeof o.managed === "object" ? { managed: decodeManagedCodex(o.managed) } : {}),
  };
}

function decodeManagedCodex(raw: object): NonNullable<CodexConfig["managed"]> {
  const value = raw as { url?: unknown; models?: unknown };
  if (typeof value.url !== "string" || !Array.isArray(value.models) || !value.models.length || value.models.some(model => typeof model !== "string" || !/^[\w][\w./+-]*$/.test(model))) {
    throw new Error("Invalid Company Codex configuration.");
  }
  const url = new URL(value.url);
  // Plain HTTP leaks the Company API key; allow it only on loopback hosts,
  // where a local proxy terminates TLS on the trusted machine instead.
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
