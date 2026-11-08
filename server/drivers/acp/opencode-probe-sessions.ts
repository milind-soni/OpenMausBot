import { readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "../../atomic.ts";

type AcpRequest = (method: string, params: unknown) => Promise<unknown>;

/** Session id -> when a probe opened it. Only ids in here are ever deleted, so another client's sessions in the
 * discovery folder survive; a probe cut off by its timeout leaves its ids for the next probe to delete. */
type ProbeSessionLedger = Record<string, number>;

const ledgerPath = (cwd: string) => join(cwd, ".openmaus-probe-sessions.json");

function readLedger(cwd: string): ProbeSessionLedger {
  try {
    const ledger: unknown = JSON.parse(readFileSync(ledgerPath(cwd), "utf8"));
    return ledger && typeof ledger === "object" && !Array.isArray(ledger) ? ledger as ProbeSessionLedger : {};
  } catch {
    return {};
  }
}

function changeLedger(cwd: string, change: (ledger: ProbeSessionLedger) => void): void {
  const ledger = readLedger(cwd);
  change(ledger);
  try {
    writeFileAtomic(ledgerPath(cwd), JSON.stringify(ledger), { durable: false });
  } catch {}
}

export interface ProbeSessions {
  record(session: unknown): void;
  deleteAll(request: AcpRequest): Promise<void>;
}

/** OpenCode (2.2.0, 2.2.6) keeps every ACP session, even one closed with session/close or whose process was killed,
 * and lists it in the user's history; only session/delete removes it, and it answers {} for an id it does not know.
 * Null when `initialized` (the initialize result) does not advertise sessionCapabilities.delete. */
export function trackProbeSessions(cwd: string, timeoutMs: number, initialized: unknown): ProbeSessions | null {
  const capabilities = (initialized as { agentCapabilities?: { sessionCapabilities?: { delete?: unknown } } } | null)
    ?.agentCapabilities?.sessionCapabilities;
  if (!capabilities?.delete) return null;
  const opened: string[] = [];
  return {
    record(session) {
      const sessionId = (session as { sessionId?: unknown } | null)?.sessionId;
      if (typeof sessionId !== "string") return;
      opened.push(sessionId);
      changeLedger(cwd, (ledger) => { ledger[sessionId] = Date.now(); });
    },
    async deleteAll(request) {
      const abandonedBefore = Date.now() - 2 * timeoutMs;
      const abandoned = Object.entries(readLedger(cwd))
        .filter(([, openedAt]) => openedAt < abandonedBefore)
        .map(([sessionId]) => sessionId);
      await Promise.all([...new Set([...opened, ...abandoned])].map((sessionId) => request("session/delete", { sessionId }).then(
        () => changeLedger(cwd, (ledger) => delete ledger[sessionId]),
        () => {},
      )));
    },
  };
}
