// Built-in driver registration — upstream builtInDrivers.ts: a static
// array, nothing more. Adding a driver = write drivers/<x>.ts, append.
import type { AnyProviderDriver } from "../contracts.ts";
import { AntigravityDriver } from "./antigravity.ts";
import { BoxAgentDriver } from "./boxagent.ts";
import { ClaudeDriver } from "./claude.ts";
import { CodexDriver } from "./codex.ts";
import { GrokDriver } from "./grok.ts";
import { GrokAgentDriver } from "./acp/grok.ts";
import { GeminiAgentDriver } from "./acp/gemini.ts";
import { KimiAgentDriver } from "./acp/kimi.ts";
import { DroidAgentDriver } from "./acp/droid.ts";
import { CursorAgentDriver } from "./acp/cursor.ts";
import { OpenCodeDriver } from "./acp/opencode-go.ts";
import { QwenAgentDriver } from "./acp/qwen.ts";
import { CustomAcpDriver } from "./acp/custom.ts";
import { HermesAgentDriver } from "./acp/hermes.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";
import { PiDriver } from "./pi.ts";
import { MinimaxDriver } from "./minimax.ts";
import { OpenMausRuntimeDriver } from "./openmaus-runtime.ts";

export const BUILT_IN_DRIVERS: readonly AnyProviderDriver[] = [
  GrokDriver,
  GrokAgentDriver,
  GeminiAgentDriver,
  KimiAgentDriver,
  DroidAgentDriver,
  CursorAgentDriver,
  OpenCodeDriver,
  QwenAgentDriver,
  HermesAgentDriver,
  CustomAcpDriver,
  PiDriver,
  OpenAICompatDriver,
  ClaudeDriver,
  CodexDriver,
  AntigravityDriver,
  BoxAgentDriver,
  MinimaxDriver,
  // preview; joins the fleet only when features.ownedRuntime is on
  OpenMausRuntimeDriver,
];
