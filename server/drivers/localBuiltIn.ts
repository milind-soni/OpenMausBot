import type { AnyProviderDriver } from "../contracts.ts";
import { AntigravityDriver } from "./antigravity.ts";
import { ClaudeDriver } from "./claude.ts";
import { CodexDriver } from "./codex.ts";
import { GeminiAgentDriver } from "./acp/gemini.ts";
import { CursorAgentDriver } from "./acp/cursor.ts";
import { CustomAcpDriver } from "./acp/custom.ts";

/** Drivers this team's live bots actually use. Full fleet: `MUSTERD_EDITION=full`. */
export const LOCAL_BUILT_IN_DRIVERS: readonly AnyProviderDriver[] = [
  ClaudeDriver,
  CodexDriver,
  AntigravityDriver,
  CursorAgentDriver,
  GeminiAgentDriver,
  CustomAcpDriver,
];
