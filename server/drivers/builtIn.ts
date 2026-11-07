import type { AnyProviderDriver } from "../contracts.ts";
import { AntigravityDriver } from "./antigravity.ts";
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
import { DeepSeekAgentDriver } from "./acp/deepseek.ts";
import { ClineAgentDriver } from "./acp/cline.ts";
import { CopilotAgentDriver } from "./acp/copilot.ts";
import { CommandCodeAgentDriver } from "./acp/command-code.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";
import { PiDriver } from "./pi.ts";
import { MistralDriver } from "./mistral.ts";
import { CerebrasDriver } from "./cerebras.ts";
import { GroqDriver } from "./groq.ts";
import { GreenferenceDriver } from "./greenference.ts";
import { MetaDriver } from "./meta.ts";
import { MuseCodeDriver } from "./muse-code.ts";
import { MinimaxDriver } from "./minimax.ts";
import { CodeBuddyDriver, CodeBuddyCnDriver } from "./acp/codebuddy.ts";
import { QoderDriver, QoderCnDriver } from "./acp/qoder.ts";
import { CodeArtsAgentDriver } from "./acp/codearts.ts";
import { McodeAgentDriver } from "./acp/mcode.ts";
import { MeooAgentDriver } from "./acp/meoo.ts";

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
  ClineAgentDriver,
  CopilotAgentDriver,
  CommandCodeAgentDriver,
  CustomAcpDriver,
  PiDriver,
  OpenAICompatDriver,
  ClaudeDriver,
  CodexDriver,
  AntigravityDriver,
  MinimaxDriver,
  MistralDriver,
  CerebrasDriver,
  GroqDriver,
  GreenferenceDriver,
  MetaDriver,
  MuseCodeDriver,
  DeepSeekAgentDriver,
  // Chinese coding CLIs. CodeBuddy and Qoder each register twice: one international, one CN endpoint.
  CodeBuddyDriver, CodeBuddyCnDriver,
  QoderDriver, QoderCnDriver,
  CodeArtsAgentDriver,
  McodeAgentDriver,
  MeooAgentDriver,
];
