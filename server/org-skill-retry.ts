const removalListeners = new Set<(botId: string) => void>();

export function onPendingOrgSkillRemoval(listener: (botId: string) => void): () => void {
  removalListeners.add(listener);
  return () => { removalListeners.delete(listener); };
}

export function notifyPendingOrgSkillRemoval(botId: string): void {
  for (const listener of removalListeners) {
    try { listener(botId); } catch (error) { console.warn(`[org-library] could not schedule skill removal recovery: ${error instanceof Error ? error.message : String(error)}`); }
  }
}

type Recovery = (botId: string) => { ok: true; pending?: true } | { error: string; retryable: true };

export function createOrgSkillRetry(options: {
  bots: () => readonly { id: string }[];
  recover?: Recovery;
  retry: () => void;
  delayMs?: number;
}) {
  let timer: ReturnType<typeof setTimeout> | null = null, disposed = false;
  const recover = () => {
    if (!options.recover) return true;
    let complete = true;
    for (const bot of options.bots()) {
      try { const result = options.recover(bot.id); if ("error" in result || result.pending) complete = false; }
      catch { complete = false; }
    }
    return complete;
  };
  const schedule = () => {
    if (timer || disposed) return;
    timer = setTimeout(() => { timer = null; if (!disposed) options.retry(); }, options.delayMs ?? 15_000);
    timer.unref?.();
  };
  return { recover, schedule, dispose: () => { disposed = true; if (timer) clearTimeout(timer); timer = null; } };
}
