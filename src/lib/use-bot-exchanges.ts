// Keeps the open conversation's bot exchanges current: one read, then held reads while work goes on.
import { createContext, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { personWrote } from "../../shared/person-wait";
import { api } from "@/state/api";
import type { Message } from "@/state/store";
import { exchangeEnded, exchangesOf, type BotExchangeEntry, type JobRead } from "./bot-exchanges";
import { t } from "./i18n";

/** The server holds a read at most this long (`JOB_WAIT_MAX_MS`). */
const HOLD_MS = 25_000;
const RETRY_MS = [2_000, 5_000, 15_000];

export interface BotExchanges {
  exchanges: BotExchangeEntry[];
  /** Stops one hand-off (`POST /api/threads/:threadId/job/:assignmentId/stop`); an `ApiError` carries a refusal. */
  stop(id: string): Promise<void>;
}

export const BotExchangesContext = createContext<BotExchanges>({ exchanges: [], stop: async () => {} });

/** When the person last wrote in this conversation: the job read starts there. */
export function latestPersonTurn(messages: readonly Message[]): number | undefined {
  return messages.findLast((message) => personWrote(message) && !message.id.startsWith("optimistic-"))?.at;
}

export function useBotExchanges(threadId: string | undefined, since: number | undefined, working: boolean): BotExchanges {
  const key = threadId ? `${threadId}:${since ?? ""}` : "";
  const [read, setRead] = useState<{ key: string; job: JobRead } | null>(null);
  const latest = useRef(read);
  latest.current = read;
  const [asked, setAsked] = useState(0);
  const stop = useCallback(async (id: string) => {
    if (!threadId) return;
    try {
      await api(`/api/threads/${encodeURIComponent(threadId)}/job/${encodeURIComponent(id)}/stop`, { method: "POST" });
    } finally {
      setAsked((count) => count + 1);
    }
  }, [threadId]);

  useEffect(() => {
    if (!threadId) return;
    const abort = new AbortController();
    const base = `/api/threads/${encodeURIComponent(threadId)}/job${since === undefined ? "" : `?since=${since}`}`;
    const join = since === undefined ? "?" : "&";
    void (async () => {
      let failures = 0;
      for (let first = true; !abort.signal.aborted; first = false) {
        const known = latest.current?.key === key ? latest.current.job : null;
        const open = Boolean(known && exchangesOf(known, "").some((entry) => !exchangeEnded(entry.state)));
        const hold = !first && known !== null && (working || open);
        if (!first && !hold && failures === 0) return;
        const path = hold ? `${base}${join}wait=${HOLD_MS}&version=${encodeURIComponent(known!.version)}` : base;
        try {
          const job = await api<JobRead>(path, { signal: abort.signal, background: true, timeoutMs: HOLD_MS + 10_000 });
          if (abort.signal.aborted) return;
          failures = 0;
          if (Array.isArray(job?.nodes)) setRead({ key, job });
          latest.current = Array.isArray(job?.nodes) ? { key, job } : latest.current;
        } catch {
          if (abort.signal.aborted || failures >= RETRY_MS.length) return;
          await pause(RETRY_MS[failures++]!, abort.signal);
        }
      }
    })();
    return () => abort.abort();
  }, [key, working, asked]);

  const teammate = t("chat.botExchange.teammate");
  const job = read?.key === key ? read.job : null;
  const exchanges = useMemo(() => job ? exchangesOf(job, teammate) : [], [job, teammate]);
  return useMemo(() => ({ exchanges, stop }), [exchanges, stop]);
}

/** An exchange opened from an earlier request, which the read from the person's latest message no longer covers. The
 * server's job read takes every hand-off still open at `since`, so reading from its "Sent to" row finds it. */
export function useEarlierExchange(threadId: string | undefined, id: string | undefined, since: number | undefined, covered: boolean): BotExchangeEntry | undefined {
  const [found, setFound] = useState<{ id: string; entry: BotExchangeEntry } | null>(null);
  const teammate = t("chat.botExchange.teammate");
  useEffect(() => {
    if (!threadId || !id || since === undefined || covered) return;
    const abort = new AbortController();
    api<JobRead>(`/api/threads/${encodeURIComponent(threadId)}/job?since=${since}`, { signal: abort.signal, background: true }).then((job) => {
      const entry = Array.isArray(job?.nodes) ? exchangesOf(job, teammate).find((candidate) => candidate.id === id) : undefined;
      if (entry && !abort.signal.aborted) setFound({ id, entry });
    }, () => {});
    return () => abort.abort();
  }, [threadId, id, since, covered, teammate]);
  return found && found.id === id ? found.entry : undefined;
}

const pause = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const stop = () => { clearTimeout(timer); resolve(); };
  const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, ms);
  signal.addEventListener("abort", stop, { once: true });
});
