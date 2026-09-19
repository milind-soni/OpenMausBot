// Method-level payload views for the ACP wire — the exact fields the shared
// runtime in core.ts reads, and nothing more. The raw frame stays in
// protocol.ts; every field here is optional because the runtime keeps its
// own defensive checks and fallbacks, so a missing or oddly-typed field
// behaves exactly as it did before these views existed.

/** One assistant content block as the runtime reads it: text or inline image. */
export interface AcpContentBlock {
  type?: string;
  text?: string;
  data?: unknown;
}

/** A tool call's `rawInput`; only `command` is read directly — the rest
 *  travels opaquely into summaries and remembered allow keys. */
export interface AcpToolCallRawInput {
  command?: unknown;
}

/** A session/update tool_call, or the toolCall of a permission request. */
export interface AcpSessionToolCall {
  toolCallId?: string;
  kind?: string;
  title?: string;
  rawInput?: AcpToolCallRawInput;
  locations?: unknown;
}

/** One option a session/request_permission payload offered. */
export interface AcpPermissionOption {
  optionId?: string;
  kind?: string;
  name?: string;
}

/** session/request_permission params: the options the agent offered and the
 *  tool call (if any) it is asking about. */
export interface AcpRequestPermissionParams {
  options?: AcpPermissionOption[];
  toolCall?: AcpSessionToolCall;
}

/** fs/read_text_file and fs/write_text_file params; `line` is 1-based and
 *  `limit` a line count, both re-validated by the runtime. */
export interface AcpClientFileParams {
  path?: string;
  line?: number;
  limit?: number;
  content?: string;
}

/** One entry of a session's config-option list (model select, effort, …). */
export interface AcpConfigOption {
  type?: string;
  id?: string;
  category?: string;
  name?: string;
  value?: string;
  currentValue?: string;
  options?: AcpConfigOption[];
}

/** Any result or update that carries a config-option list. */
export interface AcpSessionConfigResult {
  configOptions?: AcpConfigOption[];
}

/** One session/update notification's `update` field. */
export interface AcpSessionUpdate {
  sessionUpdate?: string;
  content?: AcpContentBlock;
  toolCallId?: string;
  title?: string;
  status?: string;
  rawInput?: AcpToolCallRawInput;
  rawOutput?: unknown;
  /** config_option_update carries the option list the agent switched to. */
  configOptions?: AcpConfigOption[];
}

/** session/update params. */
export interface AcpSessionUpdateParams {
  sessionId?: string;
  _meta?: { isReplay?: boolean };
  update?: AcpSessionUpdate;
}

/** session/new (or session/load / session/resume) result. */
export interface AcpSessionStartResult extends AcpSessionConfigResult {
  sessionId?: string;
  models?: { availableModels?: Array<{ modelId?: string; name?: string }> };
}

/** initialize result. */
export interface AcpInitializeResult {
  authMethods?: Array<{ id?: string }>;
  agentCapabilities?: {
    promptCapabilities?: { image?: boolean };
    mcpCapabilities?: { http?: boolean; sse?: boolean };
  };
  _meta?: { modelState?: { currentModelId?: string } };
}

/** Token usage, reported at the prompt-result root or under _meta. */
export interface AcpTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
}

/** session/prompt result — the turn's completion signal. */
export interface AcpPromptResult {
  stopReason?: string;
  error?: string;
  message?: string;
  usage?: AcpTokenUsage;
  _meta?: AcpTokenUsage;
}

/** The params view the native-log redactor reads: prompt content blocks and
 *  session/update payloads. No single method sends both; log redaction must
 *  see through either, so one view carries both. */
export interface AcpLogMessageParams {
  prompt?: AcpContentBlock[];
  update?: AcpSessionUpdate;
}
