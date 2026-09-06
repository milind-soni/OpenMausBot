export interface FeatureFlagConfig {
  features?: { skillRecorder?: boolean; showToolCalls?: boolean; browser?: boolean };
  browserEngine?: { kind: "engine" | "unavailable"; reason?: string; installable?: boolean; installing?: boolean; installError?: string };
}

/** Whether this server can give a bot a browser: the agent-browser engine is
 * installed there. Servers from before the engine report nothing: no browser. */
export function browserAvailable(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.browserEngine?.kind === "engine";
}

/** Why a bot cannot have a browser right now, in the user's words. */
export function browserUnavailableReason(config: FeatureFlagConfig | null | undefined): string {
  const engine = config?.browserEngine;
  if (engine?.kind === "unavailable" && engine.installable) return "The browser engine is not installed on this machine yet. Install it from the bot's Browser panel, or run `openmausbot browser install` on the server.";
  if (engine?.kind === "unavailable" && engine.reason) return engine.reason;
  return "This server has no browser engine.";
}

/** Experimental features are available only after an explicit opt-in. */
export function skillRecorderEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.skillRecorder === true;
}

/** The experimental built-in browser is unavailable until the person using
 * the app explicitly opts in. Each bot also has its own switch. */
export function builtInBrowserEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.browser === true;
}

/** Tool-run chips in the transcript. Off by default — the mascot already
 * shows that work is happening. */
export function showToolCallsEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.showToolCalls === true;
}
