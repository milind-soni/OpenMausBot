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

/** The instance fields only a custom endpoint has. */
export interface InstanceEndpointInfo {
  claudeEndpoint?: ClaudeEndpointInfo;
  url?: string;
}
