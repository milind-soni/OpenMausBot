import { slimResponse, type JournalEntry } from "./driver-wire.ts";

export const COMPUTER_JOURNAL_PATH = "/api/internal/computer/journal";

export function journalUrl(controlUrl: string): string {
  return new URL(COMPUTER_JOURNAL_PATH, controlUrl).href;
}

export function postJournal(url: string, token: string, fetchImpl: typeof fetch = fetch) {
  return (entry: JournalEntry, signal: AbortSignal): Promise<unknown> =>
    fetchImpl(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(entry),
      signal,
    }).then((response) => response.body?.cancel());
}

function parse(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function createJournalTap(options: {
  post: (entry: JournalEntry, signal: AbortSignal) => Promise<unknown>;
  timeoutMs?: number;
}): { request(line: string): void; leaveOut(id: unknown): void; response(line: string): Promise<void> } {
  const timeoutMs = options.timeoutMs ?? 1000;
  const pending = new Map<string | number, { tool: string; arguments: Record<string, unknown> }>();
  return {
    leaveOut(id) {
      if (typeof id === "string" || typeof id === "number") pending.delete(id);
    },
    request(line) {
      const frame = parse(line);
      if (!frame || frame.method !== "tools/call" || (typeof frame.id !== "string" && typeof frame.id !== "number")) return;
      const params = frame.params as { name?: unknown; arguments?: unknown } | undefined;
      if (typeof params?.name !== "string") return;
      const args = params.arguments;
      pending.set(frame.id, {
        tool: params.name,
        arguments: typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {},
      });
    },
    async response(line) {
      const frame = parse(line);
      if (!frame || frame.method !== undefined || (typeof frame.id !== "string" && typeof frame.id !== "number")) return;
      const call = pending.get(frame.id);
      if (!call) return;
      pending.delete(frame.id);
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const posted = Promise.resolve(options.post({ ...call, result: slimResponse(frame) }, controller.signal));
        const expired = new Promise<void>((resolve) => {
          timer = setTimeout(() => { controller.abort(); resolve(); }, timeoutMs);
        });
        await Promise.race([posted, expired]);
      } catch {
        // A slow or failed journal must never hold back the engine's reply.
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
