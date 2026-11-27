import type { Agent } from "undici";

// Node's fetch (undici 7.29 in Electron 43, 8.9 in Node 26) fails a request after 300 s without response headers
// or body bytes, whatever its signal allows. A local model sends nothing until its first token.
export const FETCH_LIMIT_MS = 300_000;
let unlimitedAgent: Agent | undefined;

export async function fetchPastLimit(url: string, init: RequestInit): Promise<Response> {
  const { Agent: UndiciAgent, fetch: fetchWithoutLimits } = await import("undici");
  unlimitedAgent ??= new UndiciAgent({ headersTimeout: 0, bodyTimeout: 0 });
  return fetchWithoutLimits(url, { ...init, dispatcher: unlimitedAgent } as Parameters<typeof fetchWithoutLimits>[1]) as unknown as Promise<Response>;
}

/** Stop this completion's wait without cancelling model preparation shared with other turns. */
export function prepareChatModel(prepare: () => Promise<string>, signal: AbortSignal): Promise<string> {
  let cleanup = () => {};
  return new Promise<string>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    cleanup = () => signal.removeEventListener("abort", abort);
    prepare().then(resolve, reject);
  }).finally(() => cleanup());
}
