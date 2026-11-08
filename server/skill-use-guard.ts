// Organization skill revisions may be in use by a provider after it has received their paths.
// Until the server supplies its turn/dispatch guard, cleanup must fail closed.
let inUse: ((botId: string) => boolean) | undefined;

export function setSkillUseGuard(guard: (botId: string) => boolean): void {
  inUse = guard;
}

export function skillMayBeInUse(botId: string): boolean {
  try { return !inUse || inUse(botId); } catch { return true; }
}
