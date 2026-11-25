// How an engine is connected, as Settings' provider card decides it: the card (src/components/EngineSetup.tsx) and what a
// bot reads in list_models (server/host/engine-hints.ts) ask the same question here, so the two never disagree.

/** The engine signs in only with an API key saved in the app. Claude's API-key instance counts once Claude Code is
 * installed: until then the card offers the install, not the key. A company-managed engine is set up by its company. */
export function keyOnlyEngine(instance: {
  access?: string;
  managed?: unknown;
  driverKind: string;
  snapshot: { version?: string | null };
}): boolean {
  if (instance.access !== "api" || instance.managed) return false;
  return instance.driverKind !== "claudeAgent" || Boolean(instance.snapshot.version);
}
