// Built-in driver registration — Vopwe trim: six engines only.
import type { AnyProviderDriver } from "../contracts.ts";
import { AntigravityDriver } from "./antigravity.ts";
import { ClaudeDriver } from "./claude.ts";
import { CodexDriver } from "./codex.ts";
import { KimiAgentDriver } from "./acp/kimi.ts";
import { OpenCodeDriver } from "./acp/opencode-go.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";

export const BUILT_IN_DRIVERS: readonly AnyProviderDriver[] = [
  OpenAICompatDriver,
  ClaudeDriver,
  CodexDriver,
  AntigravityDriver,
  KimiAgentDriver,
  OpenCodeDriver,
];
