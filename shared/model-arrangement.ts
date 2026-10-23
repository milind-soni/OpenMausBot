const DIRECT_MODEL_DRIVERS = new Set(["openai-compat", "grok", "minimax", "mistral", "cerebras", "groq", "meta"]);

export function isDirectModelDriver(driverKind: string): boolean {
  return DIRECT_MODEL_DRIVERS.has(driverKind);
}
