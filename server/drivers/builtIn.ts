// Built-in driver registration — upstream builtInDrivers.ts: a static
// array, nothing more. Adding a driver = write drivers/<x>.ts, append.
import type { AnyProviderDriver } from "../contracts.ts";
import { AntigravityDriver } from "./antigravity.ts";
import { ClaudeDriver } from "./claude.ts";
import { CodexDriver } from "./codex.ts";
import { GrokDriver } from "./grok.ts";
import { GrokAgentDriver } from "./acp/grok.ts";
import { GeminiAgentDriver } from "./acp/gemini.ts";

export const BUILT_IN_DRIVERS: readonly AnyProviderDriver[] = [
  GrokDriver,
  GrokAgentDriver,
  GeminiAgentDriver,
  ClaudeDriver,
  CodexDriver,
  AntigravityDriver,
];
