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

/** Claude Code on Amazon Bedrock, signed in with an AWS profile from this computer's ~/.aws config; holds no secret. */
export interface ClaudeBedrockInfo {
  awsProfile: string;
  awsRegion: string;
  model: string;
  models: string[];
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
  claudeBedrock?: ClaudeBedrockInfo;
  codexEndpoint?: CodexEndpointInfo;
  url?: string;
}
