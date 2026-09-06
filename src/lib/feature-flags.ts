export interface FeatureFlagConfig {
  features?: { skillRecorder?: boolean; showToolCalls?: boolean; browser?: boolean };
  browserEngine?: { kind: "desktop" | "headless" | "unavailable"; reason?: string; installable?: boolean };
}

/** Whether this server can give a bot a browser at all: the desktop app's
 * own surface, or the agent-browser engine on a server or a Windows desktop.
 * Older servers report nothing; treat that like the desktop bridge check. */
export function browserAvailable(config: FeatureFlagConfig | null | undefined, desktopBridge: boolean): boolean {
  const kind = config?.browserEngine?.kind;
  if (kind === undefined) return desktopBridge;
  return kind === "desktop" || kind === "headless";
}

/** Why a bot cannot have a browser right now, in the user's words. */
export function browserUnavailableReason(config: FeatureFlagConfig | null | undefined): string {
  const engine = config?.browserEngine;
  if (engine?.kind === "unavailable" && engine.installable) return "The browser engine is not installed on this server yet: run `openmausbot browser install` there.";
  if (engine?.kind === "unavailable" && engine.reason) return engine.reason;
  return "The built-in browser needs the OpenMausBot desktop app.";
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
