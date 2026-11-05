/** A Claude custom endpoint as the engine list shows it: where it points and what it serves, never the token. */
export interface ClaudeEndpointInfo {
  baseUrl: string;
  models: string[];
  tokenSaved: boolean;
  opusModel: string;
  sonnetModel: string;
  haikuModel: string;
  smallFastModel: string;
}

/** A direct Codex Responses API connection; the key is write-only. */
export interface CodexEndpointInfo {
  baseUrl: string;
  models: string[];
  tokenSaved: boolean;
}

/** The instance fields only a custom endpoint has. */
export interface InstanceEndpointInfo {
  claudeEndpoint?: ClaudeEndpointInfo;
  codexEndpoint?: CodexEndpointInfo;
  url?: string;
}
