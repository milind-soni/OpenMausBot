// The engine versions this release was tested with, for the copies the app installs itself (npm into tools/npm, the
// vendors' own builds into tools/standalone, Antigravity's runtime into tools/antigravity-acp). Settings' Install gives
// these versions and the updater moves older copies up to them, never past them. Each npm version below was installed
// on 2026-11-07 into a staging prefix, moved into place, and answered `--version` (and, for an ACP engine, `initialize`)
// from there; OpenCode 1.19.4 sessions, sign-ins and settings were opened by 2.2.5 the same day.
import { ANTIGRAVITY_RELEASE_VERSION } from "./drivers/antigravity-release.ts";
import { CURSOR_STANDALONE } from "./drivers/acp/cursor-release.ts";
import { OPENCODE_STANDALONE } from "./drivers/acp/opencode-release.ts";

/** Claude Code follows its vendor's newest release, as its own updater does. */
export const LATEST = "latest";

export interface EngineVersionPin {
  /** The version Install gives and the updater moves to, or LATEST. */
  target: string;
  /** The oldest version this release's driver is known to work with; the target when no older one was checked. A copy
   * below it is retried sooner after a failed update. */
  minimum: string;
  /** The arguments that start the engine's ACP server: a new copy must answer `initialize` there before it replaces one. */
  acp?: readonly string[];
  /** npm packages earlier releases installed this engine as, into the app's npm folder; the app's own build replaces them. */
  formerNpm?: readonly string[];
}

export const ENGINE_VERSIONS: Readonly<Record<string, EngineVersionPin>> = {
  claudeAgent: { target: LATEST, minimum: "2.1.267" },
  codex: { target: "0.167.0", minimum: "0.146.0" },
  geminiAgent: { target: "0.67.0", minimum: "0.67.0", acp: ["--acp"] },
  kimiAgent: { target: "2.5.2", minimum: "2.4.1", acp: ["acp"] },
  clineAgent: { target: "3.0.74", minimum: "3.0.70", acp: ["--acp", "--auto-approve", "false"] },
  copilotAgent: { target: "1.0.106", minimum: "1.0.103", acp: ["--acp", "--stdio"] },
  commandCodeAgent: { target: "1.88.4", minimum: "1.88.4", acp: ["acp"] },
  piAgent: { target: "1.5.0", minimum: "1.5.0" },
  ompAgent: { target: "18.13.1", minimum: "18.13.1", acp: ["acp"] },
  minimax: { target: "1.0.28", minimum: "1.0.28" },
  deepseekAgent: { target: "0.2.2-rc.1", minimum: "0.2.1-rc.2", acp: ["--profile", "acp"] },
  opencodeGo: { target: OPENCODE_STANDALONE.version, minimum: "1.19.4", acp: ["acp"], formerNpm: ["opencode-ai"] },
  cursorAgent: { target: CURSOR_STANDALONE.version, minimum: CURSOR_STANDALONE.version },
  antigravityAgent: { target: ANTIGRAVITY_RELEASE_VERSION, minimum: ANTIGRAVITY_RELEASE_VERSION },
};

/** The exact npm version Install asks for; undefined follows npm's `latest` tag. */
export function pinnedNpmVersion(driverKind: string): string | undefined {
  const target = ENGINE_VERSIONS[driverKind]?.target;
  return target && target !== LATEST ? target : undefined;
}
