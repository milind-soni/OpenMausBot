// A shell exporting OMB_* / OPENMAUSBOT_* leaks them into every child and import-time env snapshot.

const AMBIENT_PREFIXES = ["OMB_", "OPENMAUSBOT_"] as const;

export function isAmbientOmbKey(key: string): boolean {
  return AMBIENT_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function stripOmbEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!isAmbientOmbKey(key)) clean[key] = value;
  }
  return clean;
}

export function childEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...stripOmbEnv(process.env), ...overrides };
}
