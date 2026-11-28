const capabilityPattern = /^[A-Za-z0-9_-]{43}$/;

export function desktopMutationCapabilities(message: unknown) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const { type, token, companionToken } = message as Record<string, unknown>;
  if (type !== "openmausbot:desktop-mutation-token" ||
      typeof token !== "string" || !capabilityPattern.test(token) ||
      typeof companionToken !== "string" || !capabilityPattern.test(companionToken)) return null;
  return { token, companionToken };
}
