export interface FeatureFlagConfig {
  features?: { skillRecorder?: boolean; showToolCalls?: boolean; browser?: boolean };
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
