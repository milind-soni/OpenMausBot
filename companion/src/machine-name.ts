/** What the phone calls this computer, read from the harness's /api/config: the name set in Settings, else the
 * owner's profile name. Empty when neither is set; the caller then uses its default. */
export function machineNameFromConfig(config: unknown): string {
  const read = (config ?? {}) as { computerName?: unknown; profile?: { name?: unknown } };
  const own = typeof read.computerName === "string" ? read.computerName.trim() : "";
  if (own) return own;
  const owner = typeof read.profile?.name === "string" ? read.profile.name.trim() : "";
  return owner ? `${owner}'s computer` : "";
}
